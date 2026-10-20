// Content script: bilingual paragraph-by-paragraph translation of page *content*.
//
// - Only text inside the page's main content (main / article / .mw-parser-output)
//   is translated; navigation, controls, hidden/accessibility text, SVG, code and
//   form fields are skipped so the page's UI chrome is never mangled.
// - Each paragraph / heading / list item / table cell / caption is translated as a
//   whole from its plain innerText, so the model sees complete sentences rather
//   than fragmented text nodes (and never raw HTML, which a small model mangles).
//   Loose text that sits next to block children (e.g. "<li>Intro<ul>…</ul></li>")
//   is translated as its own inline "run".
// - The original English is left untouched; the Simplified Chinese is appended
//   below it (bilingual). This preserves images and never breaks the layout, and
//   "Remove translations" simply removes the appended blocks.
// - Visible units are sent to the server in small batches.
// - Live pages are followed: when a paragraph's text changes (e.g. an AI chat
//   streaming its answer) or hidden content is expanded, the affected region is
//   (re)translated once it has stopped changing for STABLE_MS.
// - Translations are cached in chrome.storage.local per page (URL without hash),
//   with least-recently-used eviction.
//
// Link/anchor preservation is out of scope for v1 (the 1.7B model does not reliably
// keep placeholder markers through translation); links are flattened to plain text.

(() => {
  // A tab opened before installation can be injected by the popup. Avoid
  // registering observers and message handlers twice if injection races a reload.
  if (globalThis.__localingoContentLoaded) return;
  globalThis.__localingoContentLoaded = true;
  const MSG_TRANSLATE_PAGE = "web-translator:translate-page";
  const MSG_RESTORE_PAGE = "web-translator:restore-page";
  const MSG_TOGGLE = "web-translator:toggle";
  const MSG_STATS = "web-translator:stats";
  const MSG_RETRY = "web-translator:retry-failed";
  const MSG_SHOW_RESULT = "show-result";

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEMPLATE",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH",
  ]);

  // Anything under these is UI / controls / accessibility, not article content.
  const SKIP_SELECTOR = [
    "nav", "aside", "footer", "button",
    "[role='navigation']", "[role='menubar']", "[role='toolbar']", "[role='banner']",
    "[aria-hidden='true']", "[hidden]",
    "svg", "math", "code", "pre",
    "textarea", "input", "select", "option", "[contenteditable]",
    // Wikipedia UI chrome
    ".noprint", ".mw-editsection", ".mw-jump-link", ".reflist", ".catlinks",
    ".mw-pt-languages", ".vector-toc", "#toc", "#mw-navigation", "#mw-panel",
    ".mw-sticky-header", ".vector-menu", ".vector-header", "#p-lang-btn",
    ".mw-indicators", "#siteNotice", ".siteNotice", ".mw-empty-elt",
    // our own injected elements (belt-and-suspenders)
    ".web-translator-cn", ".web-translator-spinner", ".web-translator-orig", ".web-translator-reveal",
    "localingo-learn",
  ].join(",");

  const CONTENT_ROOTS = [
    "main", "article", "[role='main']", ".mw-parser-output", ".mw-body-content",
  ];

  const BLOCK_DISPLAYS = new Set([
    "block", "list-item", "table", "table-row", "table-cell",
    "flex", "grid", "-webkit-box", "-webkit-flex",
  ]);

  // Batching: how much text to send to the server per request.
  const BATCH_MAX_UNITS = 8;
  const BATCH_MAX_CHARS = 2500;
  const MAX_UNIT_CHARS = 4000; // matches the server's per-text limit

  // Cache: pages kept in chrome.storage.local before the oldest is evicted.
  const CACHE_PREFIX = "wt:cache:";
  const CACHE_INDEX_KEY = "wt:cache-index";
  const CACHE_MAX_PAGES = 200;
  const CACHE_SAVE_DELAY_MS = 1000;

  // Live updates: a changed region must be quiet this long before (re)translating,
  // so streaming text is translated once it is complete rather than per token.
  const STABLE_MS = 1000;
  const DIRTY_TICK_MS = 400;
  const WATCHED_ATTRIBUTES = ["class", "style", "hidden", "open", "aria-hidden", "aria-expanded"];

  // A unit is { host, run }: `host` is the element observed for visibility;
  // `run` is null for a whole-element unit, or the list of loose inline nodes
  // (text + inline elements) inside `host` that form one segment. Each unit is
  // identified by its key node: `host` itself, or the run's first node.
  let translatedKeys = new WeakSet(); // units already translated
  let pending = new WeakSet();        // units queued or in flight (dedupe)
  let cnBlocks = new Map();           // key node -> injected translation element
  let observed = new Map();           // observed element -> units waiting on it
  let intersectionObserver = null;
  let mutationObserver = null;
  let session = 0;                    // bumped on restore; stale results are dropped
  let dirty = new Map();              // block element -> time of its last mutation
  let dirtyTimer = null;

  let queue = [];
  let processing = false;
  let lastError = null;
  let inFlight = 0;
  const failedUnits = new Map();

  let cache = null;
  let cacheKey = null;
  let saveTimer = null;

  const stats = { collected: 0, translated: 0, cached: 0, failed: 0, skipped: 0 };

  // --- helpers -------------------------------------------------------------

  function findContentRoot() {
    for (const sel of CONTENT_ROOTS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return document.body;
  }

  function isBlockElement(el) {
    return BLOCK_DISPLAYS.has(getComputedStyle(el).display);
  }

  function hasText(el) {
    const t = el.innerText;
    return !!t && t.trim().length > 0;
  }

  function isHidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return true;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  }

  function isSkipped(el) {
    return SKIP_TAGS.has(el.tagName) || !!el.closest(SKIP_SELECTOR);
  }

  // A translation unit is the innermost block element that contains text: it has
  // no block-level child that itself contains text (and isn't skipped).
  function isUnit(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isSkipped(el)) return false;
    if (!isBlockElement(el)) return false;
    if (!hasText(el)) return false;
    if (isHidden(el)) return false;
    // Already holds a translated loose run: that run is the unit, not the block.
    if (el.querySelector(".web-translator-cn")) return false;
    for (const child of el.children) {
      if (isSkipped(child)) continue;
      if (isBlockElement(child) && hasText(child)) return false; // recurse into it
    }
    return true;
  }

  function keyOf(unit) {
    return unit.run ? unit.run[0] : unit.host;
  }

  function unitText(unit) {
    if (!unit.run) return unit.host.innerText.trim();
    return unit.run
      .map((n) => (n.nodeType === Node.TEXT_NODE ? n.textContent : n.innerText))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Plain-text fingerprint of a subtree, ignoring our own injected nodes and
  // independent of display mode — used to notice when the source text changed.
  function textSig(root) {
    let out = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest(".web-translator-cn, .web-translator-spinner")) continue;
      out += n.textContent;
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function unitSig(unit) {
    if (!unit.run) return textSig(unit.host);
    return unit.run.map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
  }

  // Worth translating: at least 2 chars and some Latin letters (skips pure
  // numbers, symbols, and text that is already Chinese).
  function isTranslatable(text) {
    return text.length >= 2 && /[A-Za-z]/.test(text);
  }

  function containsBlock(el) {
    for (const child of el.children) {
      if (isSkipped(child)) continue;
      if (isBlockElement(child) || containsBlock(child)) return true;
    }
    return false;
  }

  function collectUnits(root, countSkipped = false) {
    const out = [];
    (function walk(node) {
      let run = [];
      const flush = () => {
        if (run.length && !translatedKeys.has(run[0])) {
          const unit = { host: node, run };
          if (isTranslatable(unitText(unit))) out.push(unit);
        }
        run = [];
      };
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          run.push(child);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (isSkipped(child)) {
          if (isBlockElement(child)) {
            flush();
            if (countSkipped && hasText(child)) stats.skipped++;
          }
          continue;
        }
        if (!isBlockElement(child)) {
          if (containsBlock(child)) {
            // Inline wrapper around blocks (custom elements, display:contents).
            flush();
            walk(child);
          } else if (!isHidden(child)) {
            run.push(child); // inline: part of the loose-text run
          }
          continue;
        }
        flush();
        // No rendered text (e.g. inside a closed <details>): nothing to translate yet;
        // the live-update pass picks it up when it is revealed.
        if (translatedKeys.has(child) || isHidden(child) || !hasText(child)) continue;
        if (isUnit(child)) out.push({ host: child, run: null });
        else walk(child);
      }
      flush();
    })(root);
    return out;
  }

  // --- display settings -------------------------------------------------

  // displayMode: "learn" (English first; reveal one paragraph's Chinese on demand) |
  //              "bilingual" (Chinese below the original) | "translation" (Chinese only).
  // translationStyle: "plain" (looks like the page's own text) | "muted" | "underline".
  const DEFAULT_SETTINGS = { displayMode: "bilingual", translationStyle: "plain" };
  const STYLES = new Set(["plain", "muted", "underline"]);
  let settings = { ...DEFAULT_SETTINGS };

  const isLearnMode = (mode = settings.displayMode) => mode === "learn";

  function applySettings(previousMode) {
    const root = document.documentElement;
    // Switching between 学习阅读 and full-page translation while active changes what
    // gets translated, so restart quietly (cached translations make this fast).
    if (previousMode && intersectionObserver && isLearnMode(previousMode) !== isLearnMode()) {
      restorePage({ quiet: true });
      startTranslating({ quiet: true });
    }
    root.dataset.wtMode = settings.displayMode;
    root.dataset.wtStyle = STYLES.has(settings.translationStyle) ? settings.translationStyle : "plain";
    // In translation-only mode, hovering a translation shows the original.
    for (const entry of cnBlocks.values()) {
      entry.span.title = settings.displayMode === "translation" ? entry.source : "";
    }
  }

  async function loadSettings() {
    try {
      settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) };
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
    applySettings();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      let changed = false;
      const previousMode = settings.displayMode;
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[k]) {
          settings[k] = changes[k].newValue ?? DEFAULT_SETTINGS[k];
          changed = true;
        }
      }
      if (changed) applySettings(previousMode);
    });
  } catch {
    // storage events unavailable — settings apply on next page load
  }

  // --- toast & selection tooltip ------------------------------------------

  // kind: "progress" (spinner, stays until replaced) | "success" | "error" | "info".
  function showToast(message, kind = "info") {
    let toast = document.getElementById("web-translator-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "web-translator-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      const icon = document.createElement("span");
      icon.className = "web-translator-toast-icon";
      const text = document.createElement("span");
      text.className = "web-translator-toast-text";
      toast.append(icon, text);
      document.documentElement.appendChild(toast);
    }
    toast.dataset.kind = kind;
    toast.querySelector(".web-translator-toast-text").textContent = message;
    toast.classList.add("web-translator-visible");
    clearTimeout(showToast._timer);
    if (kind !== "progress") {
      showToast._timer = setTimeout(
        () => toast.classList.remove("web-translator-visible"),
        kind === "error" ? 8000 : 3500,
      );
    }
  }

  // Shared with content-learn.js (same isolated world).
  globalThis.__localingoCore = { showToast };

  function closeTooltip() {
    document.querySelectorAll(".web-translator-tooltip").forEach((el) => el.remove());
    document.removeEventListener("keydown", onTooltipKey, true);
    document.removeEventListener("mousedown", onTooltipOutside, true);
  }

  function onTooltipKey(e) {
    if (e.key === "Escape") closeTooltip();
  }

  function onTooltipOutside(e) {
    if (!e.target.closest || !e.target.closest(".web-translator-tooltip")) closeTooltip();
  }

  function positionTooltip(tooltip, rect) {
    const margin = 8;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    let left = rect ? rect.left : (window.innerWidth - width) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect ? rect.bottom + margin : (window.innerHeight - height) / 2;
    // Flip above the selection when there's no room below.
    if (rect && top + height > window.innerHeight - margin && rect.top - height - margin > margin) {
      top = rect.top - height - margin;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  function selectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : null;
  }

  // state: { original, translation?, error?, loading? }
  function showResultTooltip(state) {
    let tooltip = document.querySelector(".web-translator-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "web-translator-tooltip";
      tooltip.setAttribute("role", "dialog");
      tooltip.setAttribute("aria-label", "划词翻译");
      tooltip.innerHTML = `
        <div class="web-translator-tooltip-head">
          <span class="web-translator-tooltip-title">LocaLingo</span>
          <button type="button" class="web-translator-tooltip-btn" data-action="copy" title="复制译文">复制</button>
          <button type="button" class="web-translator-tooltip-btn" data-action="close" title="关闭 (Esc)" aria-label="关闭">×</button>
        </div>
        <div class="web-translator-tooltip-original"></div>
        <div class="web-translator-tooltip-body"></div>`;
      tooltip.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        if (btn.dataset.action === "close") closeTooltip();
        if (btn.dataset.action === "copy") {
          const text = tooltip.querySelector(".web-translator-tooltip-body").textContent;
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = "已复制";
            setTimeout(() => { btn.textContent = "复制"; }, 1200);
          }).catch(() => {});
        }
      });
      document.documentElement.appendChild(tooltip);
      document.addEventListener("keydown", onTooltipKey, true);
      document.addEventListener("mousedown", onTooltipOutside, true);
      tooltip._rect = selectionRect();
    }

    const original = tooltip.querySelector(".web-translator-tooltip-original");
    const body = tooltip.querySelector(".web-translator-tooltip-body");
    original.textContent = state.original || "";
    original.hidden = !state.original;
    tooltip.dataset.state = state.loading ? "loading" : state.error ? "error" : "done";
    tooltip.querySelector('[data-action="copy"]').hidden = !state.translation;
    if (state.loading) {
      body.innerHTML = '<span class="web-translator-dots"><i></i><i></i><i></i></span>';
    } else {
      body.textContent = state.error ? `翻译失败：${state.error}` : state.translation;
    }
    positionTooltip(tooltip, tooltip._rect);
  }

  // --- cache ---------------------------------------------------------------

  function pageKey() {
    return `${CACHE_PREFIX}${location.origin}${location.pathname}${location.search}`;
  }

  // Loads the cache for the current URL; reloads when an SPA navigates.
  async function loadCache() {
    const key = pageKey();
    if (cache && key === cacheKey) return cache;
    if (cache) flushCache();
    cacheKey = key;
    try {
      const stored = await chrome.storage.local.get(key);
      cache = stored[key] || {};
    } catch {
      cache = {};
    }
    return cache;
  }

  function scheduleSaveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushCache, CACHE_SAVE_DELAY_MS);
  }

  async function evictOldest(index, count) {
    const oldest = Object.entries(index)
      .sort((a, b) => a[1] - b[1])
      .slice(0, count)
      .map(([k]) => k);
    for (const k of oldest) delete index[k];
    await chrome.storage.local.remove(oldest);
  }

  async function flushCache() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!cache || !cacheKey) return;
    const key = cacheKey;
    const data = cache;
    try {
      const { [CACHE_INDEX_KEY]: index = {} } = await chrome.storage.local.get(CACHE_INDEX_KEY);
      index[key] = Date.now();
      const excess = Object.keys(index).length - CACHE_MAX_PAGES;
      if (excess > 0) await evictOldest(index, excess);
      try {
        await chrome.storage.local.set({ [key]: data, [CACHE_INDEX_KEY]: index });
      } catch {
        // Probably over quota: drop the oldest pages and retry once.
        await evictOldest(index, 20);
        await chrome.storage.local.set({ [key]: data, [CACHE_INDEX_KEY]: index });
      }
    } catch {
      // cache is best-effort
    }
  }

  // --- translate & append --------------------------------------------------

  // Run `fn` (which changes the DOM) without our mutation observer reacting to
  // its changes: page mutations recorded so far are handled first, then the
  // records our own change produced are discarded.
  function withoutObserving(fn) {
    if (mutationObserver) onMutations(mutationObserver.takeRecords());
    try {
      return fn();
    } finally {
      if (mutationObserver) mutationObserver.takeRecords();
    }
  }

  // When all of a unit's text sits in one inline element (e.g. <h2><a>Title</a></h2>
  // or <p><em>…</em></p>), return that element so the translation placed inside it
  // gets the same link color, weight and decoration as the original.
  function styleTarget(host) {
    let el = host;
    for (;;) {
      const nodes = [...el.childNodes].filter((n) =>
        n.nodeType === Node.ELEMENT_NODE
          ? !n.classList.contains("web-translator-spinner") && !n.classList.contains("web-translator-reveal")
          : n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
      );
      if (nodes.length !== 1 || nodes[0].nodeType !== Node.ELEMENT_NODE) return el;
      const child = nodes[0];
      if (isSkipped(child) || isBlockElement(child) || isHidden(child)) return el;
      el = child;
    }
  }

  // Place `node` below the unit: inside the element for whole-element units, or
  // right after the last node of an inline run. A <span> with display:block is
  // valid inside <p>, <td>, <li>, <h1>, etc., so this never produces invalid markup.
  function insertForUnit(unit, node) {
    withoutObserving(() => {
      if (unit.run) unit.run[unit.run.length - 1].after(node);
      else unit.host.appendChild(node);
    });
  }

  function appendTranslation(unit, translation, source) {
    const span = document.createElement("span");
    span.className = "web-translator-cn";
    span.textContent = translation;
    span.lang = "zh-CN";
    if (settings.displayMode === "translation") span.title = source;
    const entry = { span, source, sig: unitSig(unit), unitHost: unit.host, host: null, wrapper: null };

    withoutObserving(() => {
      if (unit.run) {
        const cs = getComputedStyle(unit.host);
        span.style.setProperty("--wt-fs", cs.fontSize);
        span.style.setProperty("--wt-lh", cs.lineHeight);
        // Wrap the loose run so translation-only mode can hide it. The wrapper is
        // display:contents, so bilingual layout is unchanged.
        const wrapper = document.createElement("span");
        wrapper.className = "web-translator-orig";
        unit.run[0].before(wrapper);
        wrapper.append(...unit.run);
        wrapper.after(span);
        entry.wrapper = wrapper;
      } else {
        const target = styleTarget(unit.host);
        const cs = getComputedStyle(target);
        // Pin the original's font size / line height and em-based box spacing, so
        // translation-only mode (font-size:0 on the original) doesn't change them.
        const pinned = {
          "--wt-fs": cs.fontSize,
          "--wt-lh": cs.lineHeight,
          "--wt-mt": cs.marginTop,
          "--wt-mb": cs.marginBottom,
          "--wt-pad": `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        };
        for (const [k, v] of Object.entries(pinned)) target.style.setProperty(k, v);
        target.classList.add("web-translator-host");
        target.appendChild(span);
        entry.host = target;
      }
    });
    translatedKeys.add(keyOf(unit));
    cnBlocks.set(keyOf(unit), entry);
    const btn = revealButtons.get(keyOf(unit));
    if (btn) setRevealState(btn, "shown");
  }

  function removeTranslation(entry) {
    withoutObserving(() => {
      entry.span.remove();
      if (entry.wrapper && entry.wrapper.isConnected) entry.wrapper.replaceWith(...entry.wrapper.childNodes);
      if (entry.host) {
        entry.host.classList.remove("web-translator-host");
        for (const k of ["--wt-fs", "--wt-lh", "--wt-mt", "--wt-mb", "--wt-pad"]) {
          entry.host.style.removeProperty(k);
        }
        if (!entry.host.getAttribute("style")) entry.host.removeAttribute("style");
        if (!entry.host.getAttribute("class")) entry.host.removeAttribute("class");
      }
    });
  }

  function entrySig(entry) {
    return entry.wrapper ? textSig(entry.wrapper) : textSig(entry.unitHost);
  }

  function isLive(unit) {
    const key = keyOf(unit);
    return key.isConnected && !translatedKeys.has(key);
  }

  async function translateBatch(batch) {
    const mySession = session;
    const c = await loadCache();
    if (mySession !== session) return;

    const todo = [];
    for (const item of batch) {
      if (c[item.text]) {
        appendTranslation(item.unit, c[item.text], item.text);
        stats.cached++;
      } else {
        todo.push(item);
      }
    }
    if (todo.length === 0) return;

    for (const item of todo) {
      item.spinner = document.createElement("span");
      item.spinner.className = "web-translator-spinner";
      item.spinner.setAttribute("aria-label", "translating");
      insertForUnit(item.unit, item.spinner);
    }

    let translations = null;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "translate-texts",
        texts: todo.map((item) => item.text),
      });
      if (resp && resp.ok) translations = resp.translations;
      else lastError = (resp && resp.error) || "no response from extension";
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }

    withoutObserving(() => {
      for (const item of todo) item.spinner.remove();
    });
    if (mySession !== session) return; // translations were removed meanwhile

    todo.forEach((item, i) => {
      const translation = translations && translations[i];
      if (!isLive(item.unit) || unitSig(item.unit) !== item.sig) {
        return; // the text changed while translating; the live-update pass redoes it
      }
      if (!translation) {
        failedUnits.set(keyOf(item.unit), item.unit);
        stats.failed = failedUnits.size;
        const btn = revealButtons.get(keyOf(item.unit));
        if (btn) setRevealState(btn, "failed");
        return;
      }
      failedUnits.delete(keyOf(item.unit));
      stats.failed = failedUnits.size;
      appendTranslation(item.unit, translation, item.text);
      c[item.text] = translation;
      stats.translated++;
    });
    scheduleSaveCache();
  }

  function enqueue(unit) {
    const key = keyOf(unit);
    if (!key.isConnected || translatedKeys.has(key) || pending.has(key)) return;
    pending.add(key);
    queue.push(unit);
    stats.collected++;
    processQueue();
  }

  // Take up to BATCH_MAX_UNITS / BATCH_MAX_CHARS of queued units per request.
  function nextBatch() {
    const batch = [];
    let chars = 0;
    while (queue.length > 0 && batch.length < BATCH_MAX_UNITS) {
      const unit = queue[0];
      if (!isLive(unit)) {
        queue.shift();
        pending.delete(keyOf(unit));
        continue;
      }
      const text = unitText(unit);
      if (!isTranslatable(text) || text.length > MAX_UNIT_CHARS) {
        queue.shift();
        pending.delete(keyOf(unit));
        stats.skipped++;
        continue;
      }
      if (batch.length > 0 && chars + text.length > BATCH_MAX_CHARS) break;
      queue.shift();
      batch.push({ unit, text, sig: unitSig(unit) });
      chars += text.length;
    }
    return batch;
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    let userVisible = false; // any unit from the page pass / scrolling (not a live update)
    try {
      while (queue.length > 0) {
        const batch = nextBatch();
        if (batch.length === 0) continue;
        if (batch.some((item) => !item.unit.live)) userVisible = true;
        if (intersectionObserver && userVisible && !isLearnMode()) {
          const done = stats.translated + stats.cached;
          showToast(`正在翻译… 已完成 ${done} 段，队列中 ${queue.length + batch.length} 段`, "progress");
        }
        const batchSession = session;
        try {
          inFlight = batch.length;
          await translateBatch(batch);
        } finally {
          inFlight = 0;
          // Restore/restart may have replaced the pending set while we awaited.
          if (batchSession === session) {
            for (const item of batch) pending.delete(keyOf(item.unit));
          }
        }
      }
    } finally {
      processing = false;
    }
    if (!intersectionObserver) return;
    // Page/scroll passes report their result; live updates and single-paragraph
    // reveals (学习阅读) only speak up on errors.
    if ((userVisible && !isLearnMode()) || stats.failed > reportStats.failedShown) reportStats();
  }

  function reportStats() {
    const parts = [`已翻译 ${stats.translated} 段`];
    if (stats.cached) parts.push(`缓存 ${stats.cached}`);
    if (stats.failed) parts.push(`失败 ${stats.failed}`);
    if (stats.skipped) parts.push(`跳过 ${stats.skipped}`);
    let line = parts.join(" · ");
    let kind = "success";
    if (stats.failed > 0) {
      kind = "error";
      if (lastError) line += ` — ${lastError}`;
    }
    reportStats.failedShown = stats.failed;
    showToast(line, kind);
    try {
      chrome.storage.session.set({ "wt:lastStats": { ...stats, line } });
    } catch {
      // storage.session may be unavailable on old Chrome — ignore
    }
  }

  // --- viewport / mutation observers --------------------------------------

  // --- 学习阅读: reveal one paragraph at a time -------------------------------

  const revealButtons = new Map(); // unit key -> button

  function setRevealState(btn, state) {
    btn.dataset.state = state;
    btn.setAttribute("aria-pressed", String(state === "shown"));
    const label = { idle: "显示这段的中文译文", loading: "正在翻译这段", shown: "收起这段译文", hidden: "显示这段的中文译文", failed: "翻译失败，点击重试" }[state];
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }

  function attachReveal(unit) {
    const key = keyOf(unit);
    const existing = revealButtons.get(key);
    if (existing && existing.isConnected) {
      // Its translation may have been dropped because the paragraph changed.
      if (!translatedKeys.has(key) && !pending.has(key)) setRevealState(existing, "idle");
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "web-translator-reveal";
    setRevealState(btn, translatedKeys.has(key) ? "shown" : "idle");
    btn.addEventListener("click", (e) => {
      // Don't trigger links or click handlers of the paragraph around the button.
      e.preventDefault();
      e.stopPropagation();
      onReveal(unit, btn);
    });
    insertForUnit(unit, btn);
    revealButtons.set(key, btn);
  }

  function onReveal(unit, btn) {
    const key = keyOf(unit);
    const entry = cnBlocks.get(key);
    if (entry) {
      const hide = !entry.span.classList.contains("web-translator-collapsed");
      withoutObserving(() => entry.span.classList.toggle("web-translator-collapsed", hide));
      setRevealState(btn, hide ? "hidden" : "shown");
      return;
    }
    if (pending.has(key)) return;
    setRevealState(btn, "loading");
    unit.live = false;
    unit.reveal = true;
    enqueue(unit);
  }

  function observeUnit(unit) {
    if (!intersectionObserver || !keyOf(unit).isConnected) return;
    if (isLearnMode()) {
      attachReveal(unit);
      return;
    }
    const target = unit.host;
    let waiting = observed.get(target);
    if (!waiting) {
      waiting = [];
      observed.set(target, waiting);
      intersectionObserver.observe(target);
    }
    waiting.push(unit);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      intersectionObserver.unobserve(entry.target);
      const waiting = observed.get(entry.target) || [];
      observed.delete(entry.target);
      for (const unit of waiting) enqueue(unit);
    }
  }

  // --- live updates ------------------------------------------------------

  function blockAncestor(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body && !isBlockElement(el)) el = el.parentElement;
    return el;
  }

  // Page mutations mark their nearest block ancestor dirty; processDirty picks a
  // region up once it has been quiet for STABLE_MS.
  function onMutations(mutations) {
    if (!mutationObserver) return;
    const now = Date.now();
    const root = findContentRoot();
    for (const m of mutations) {
      const target = m.target;
      if (m.type === "attributes") {
        // Page-level toggles (scroll classes on <body>, themes) aren't reveals.
        if (target === document.body || target === document.documentElement || target.contains(root)) continue;
      }
      const el = blockAncestor(target);
      if (!el || !el.isConnected || isSkipped(el)) continue;
      dirty.set(el, now);
    }
    if (dirty.size && !dirtyTimer) dirtyTimer = setInterval(processDirty, DIRTY_TICK_MS);
  }

  function stillChanging(el, now) {
    const t = dirty.get(el);
    return t !== undefined && now - t < STABLE_MS;
  }

  function processDirty() {
    const now = Date.now();
    const ready = [];
    for (const [el, t] of dirty) if (now - t >= STABLE_MS) ready.push(el);
    for (const el of ready) dirty.delete(el);
    if (!dirty.size) {
      clearInterval(dirtyTimer);
      dirtyTimer = null;
    }
    // Nested regions are covered by their outermost ready ancestor's rescan.
    const roots = ready.filter((el) => el.isConnected && !ready.some((o) => o !== el && o.contains(el)));
    for (const el of roots) rescan(el, now);
  }

  function rescan(el, now) {
    // 1. Drop translations whose source changed, or that the page re-rendered away.
    for (const [key, entry] of cnBlocks) {
      const gone = !key.isConnected;
      if (!gone && !(el.contains(entry.unitHost) || entry.unitHost.contains(el))) continue;
      if (!gone && entry.span.isConnected && entrySig(entry) === entry.sig) continue;
      removeTranslation(entry);
      cnBlocks.delete(key);
      translatedKeys.delete(key);
    }
    // 2. Collect untranslated units (new, changed, or just revealed) in the region.
    if (!el.isConnected || isSkipped(el) || isHidden(el)) return;
    const units = isUnit(el) ? [{ host: el, run: null }] : collectUnits(el);
    for (const unit of units) {
      unit.live = true; // live updates translate quietly (no progress toast)
      if (!stillChanging(unit.host, now)) observeUnit(unit);
    }
  }

  function startTranslating({ quiet = false } = {}) {
    if (intersectionObserver) return; // already running

    resetStats();
    lastError = null;
    reportStats.failedShown = 0;
    const root = findContentRoot();

    intersectionObserver = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: "0px 0px 400px 0px", // prefetch a little below the fold
      threshold: 0,
    });

    mutationObserver = new MutationObserver(onMutations);
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });

    // Visible text translates now; the rest as it scrolls into view.
    const units = collectUnits(root, true);
    for (const unit of units) observeUnit(unit);
    if (quiet) return;
    if (!units.length) showToast("没有找到可翻译的英文正文", "info");
    else if (isLearnMode()) showToast("学习阅读已开启：先读原文，点段落末尾的「译」只看这一段的中文", "info");
    else showToast("阅读翻译已开启，滚动时会自动翻译英文正文", "info");
  }

  function stopTranslating() {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    observed.clear();
    dirty.clear();
    clearInterval(dirtyTimer);
    dirtyTimer = null;
  }

  function restorePage({ quiet = false } = {}) {
    const wasRunning = !!intersectionObserver;
    stopTranslating();
    session++;
    let count = 0;
    for (const entry of cnBlocks.values()) {
      removeTranslation(entry);
      count++;
    }
    withoutObserving(() => {
      document.querySelectorAll(".web-translator-spinner, .web-translator-reveal").forEach((el) => el.remove());
    });
    revealButtons.clear();
    cnBlocks.clear();
    translatedKeys = new WeakSet();
    pending = new WeakSet();
    queue = [];
    resetStats();
    if (quiet) return;
    if (count) showToast(`已恢复原文（移除 ${count} 段译文）`);
    else showToast(wasRunning ? "已停止翻译" : "当前页面没有译文");
  }

  function resetStats() {
    failedUnits.clear();
    stats.collected = 0;
    stats.translated = 0;
    stats.cached = 0;
    stats.failed = 0;
    stats.skipped = 0;
  }

  function retryFailed() {
    if (!intersectionObserver || processing) return;
    const units = [...failedUnits.values()];
    failedUnits.clear();
    stats.failed = 0;
    lastError = null;
    for (const unit of units) {
      if (!isLive(unit)) continue;
      unit.live = false;
      enqueue(unit);
    }
  }

  loadSettings();

  window.addEventListener("pagehide", () => {
    if (saveTimer) flushCache();
  });

  // --- message routing -----------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return;
    if (message.type === MSG_TRANSLATE_PAGE) {
      startTranslating();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MSG_RESTORE_PAGE) {
      restorePage();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MSG_TOGGLE) {
      if (intersectionObserver || cnBlocks.size > 0) restorePage();
      else startTranslating();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MSG_STATS) {
      // Discard failures whose source nodes have disappeared or been translated.
      for (const [key, unit] of failedUnits) {
        if (!isLive(unit)) failedUnits.delete(key);
      }
      stats.failed = failedUnits.size;
      sendResponse({
        ok: true,
        stats: { ...stats },
        active: !!intersectionObserver || cnBlocks.size > 0,
        mode: settings.displayMode,
        processing: !!intersectionObserver && processing,
        queued: queue.length,
        inFlight: intersectionObserver ? inFlight : 0,
        waiting: [...observed.values()].reduce((sum, units) => sum + units.length, 0),
      });
      return;
    }
    if (message.type === MSG_RETRY) {
      retryFailed();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === MSG_SHOW_RESULT) {
      showResultTooltip(message);
      sendResponse({ ok: true });
      return;
    }
  });
})();
