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
// - Translations are cached in chrome.storage.local per page (URL without hash),
//   with least-recently-used eviction.
//
// Link/anchor preservation is out of scope for v1 (the 1.7B model does not reliably
// keep placeholder markers through translation); links are flattened to plain text.

(() => {
  const MSG_TRANSLATE_PAGE = "web-translator:translate-page";
  const MSG_RESTORE_PAGE = "web-translator:restore-page";
  const MSG_TOGGLE = "web-translator:toggle";
  const MSG_STATS = "web-translator:stats";
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
    ".web-translator-cn", ".web-translator-spinner",
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

  let queue = [];
  let processing = false;
  let lastError = null;

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
        if (translatedKeys.has(child) || isHidden(child)) continue;
        if (isUnit(child)) out.push({ host: child, run: null });
        else walk(child);
      }
      flush();
    })(root);
    return out;
  }

  // --- toast & selection tooltip ------------------------------------------

  function showToast(message) {
    let toast = document.getElementById("web-translator-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "web-translator-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.display = "block";
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => { toast.style.display = "none"; }, 4000);
  }

  function showResultTooltip(translation) {
    document.querySelectorAll(".web-translator-tooltip").forEach((el) => el.remove());

    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.left || rect.top)) {
        x = rect.left;
        y = rect.bottom;
      }
    }

    const tooltip = document.createElement("div");
    tooltip.className = "web-translator-tooltip";

    const close = document.createElement("button");
    close.className = "web-translator-tooltip-close";
    close.textContent = "×";
    close.addEventListener("click", () => tooltip.remove());

    const body = document.createElement("div");
    body.textContent = translation;

    tooltip.append(close, body);
    document.documentElement.appendChild(tooltip);

    const width = 360;
    tooltip.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 16))}px`;
    tooltip.style.top = `${y + 8}px`;
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

  // Place `node` below the unit: inside the element for whole-element units, or
  // right after the last node of an inline run. A <span> with display:block is
  // valid inside <p>, <td>, <li>, <h1>, etc., so this never produces invalid markup.
  function insertForUnit(unit, node) {
    if (unit.run) unit.run[unit.run.length - 1].after(node);
    else unit.host.appendChild(node);
  }

  function appendTranslation(unit, translation) {
    const span = document.createElement("span");
    span.className = "web-translator-cn";
    span.textContent = translation;
    insertForUnit(unit, span);
    translatedKeys.add(keyOf(unit));
    cnBlocks.set(keyOf(unit), span);
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
        appendTranslation(item.unit, c[item.text]);
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

    for (const item of todo) item.spinner.remove();
    if (mySession !== session) return; // translations were removed meanwhile

    todo.forEach((item, i) => {
      const translation = translations && translations[i];
      if (!translation || !isLive(item.unit)) {
        stats.failed++;
        return;
      }
      appendTranslation(item.unit, translation);
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
      batch.push({ unit, text });
      chars += text.length;
    }
    return batch;
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const batch = nextBatch();
        if (batch.length === 0) continue;
        try {
          await translateBatch(batch);
        } finally {
          for (const item of batch) pending.delete(keyOf(item.unit));
        }
      }
    } finally {
      processing = false;
    }
    if (intersectionObserver) reportStats();
  }

  function reportStats() {
    let line = `Translated ${stats.translated} · ${stats.cached} cached · ${stats.failed} failed · ${stats.skipped} skipped`;
    if (stats.failed > 0 && lastError) line += ` — ${lastError}`;
    showToast(line);
    try {
      chrome.storage.session.set({ "wt:lastStats": { ...stats, line } });
    } catch {
      // storage.session may be unavailable on old Chrome — ignore
    }
  }

  // --- viewport / mutation observers --------------------------------------

  function observeUnit(unit) {
    if (!intersectionObserver || !keyOf(unit).isConnected) return;
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

  function observeNewNodes(nodes) {
    for (const node of nodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (isSkipped(node)) continue;
        // An added node may itself be a unit (e.g. a single new <p>).
        if (isUnit(node)) {
          observeUnit({ host: node, run: null });
          continue;
        }
      } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        continue;
      }
      for (const unit of collectUnits(node)) observeUnit(unit);
    }
  }

  function startTranslating() {
    if (intersectionObserver) return; // already running

    resetStats();
    lastError = null;
    const root = findContentRoot();

    intersectionObserver = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: "0px 0px 400px 0px", // prefetch a little below the fold
      threshold: 0,
    });

    mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) observeNewNodes(m.addedNodes);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    // Visible text translates now; the rest as it scrolls into view.
    for (const unit of collectUnits(root, true)) observeUnit(unit);

    showToast("Translating text — scroll for more.");
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
  }

  function restorePage() {
    const wasRunning = !!intersectionObserver;
    stopTranslating();
    session++;
    let count = 0;
    for (const span of cnBlocks.values()) {
      if (span.isConnected) span.remove();
      count++;
    }
    document.querySelectorAll(".web-translator-spinner").forEach((el) => el.remove());
    cnBlocks.clear();
    translatedKeys = new WeakSet();
    pending = new WeakSet();
    queue = [];
    resetStats();
    if (count) showToast(`Removed ${count} translations.`);
    else showToast(wasRunning ? "Translation stopped." : "Nothing to restore.");
  }

  function resetStats() {
    stats.collected = 0;
    stats.translated = 0;
    stats.cached = 0;
    stats.failed = 0;
    stats.skipped = 0;
  }

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
      sendResponse({ ok: true, stats: { ...stats } });
      return;
    }
    if (message.type === MSG_SHOW_RESULT) {
      showResultTooltip(message.translation);
      sendResponse({ ok: true });
      return;
    }
  });
})();
