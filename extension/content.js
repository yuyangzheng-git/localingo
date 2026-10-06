// Content script: bilingual paragraph-by-paragraph translation of page *content*.
//
// - Only text inside the page's main content (main / article / .mw-parser-output)
//   is translated; navigation, controls, hidden/accessibility text, SVG, code and
//   form fields are skipped so the page's UI chrome is never mangled.
// - Each paragraph / heading / list item / table cell / caption is translated as a
//   whole from its plain innerText, so the model sees complete sentences rather
//   than fragmented text nodes (and never raw HTML, which a small model mangles).
// - The original English is left untouched; the Simplified Chinese is appended
//   below it (bilingual). This preserves images and never breaks the layout, and
//   "Remove translations" simply removes the appended blocks.
// - Translations are cached in chrome.storage.local keyed by URL + source text.
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
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE",
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

  let translatedParagraphs = new WeakSet(); // units already translated
  let pending = new WeakSet();              // units in the queue (dedupe)
  let cnBlocks = new Map();                 // unit -> injected translation element
  let intersectionObserver = null;
  let mutationObserver = null;

  let queue = [];
  let processing = false;

  let cache = null;
  let cacheKey = null;
  let cacheLoaded = false;

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

  // A translation unit is the innermost block element that contains text: it has
  // no block-level child that itself contains text (and isn't skipped).
  function isUnit(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.closest(SKIP_SELECTOR)) return false;
    if (!isBlockElement(el)) return false;
    if (!hasText(el)) return false;
    if (isHidden(el)) return false;
    for (const child of el.children) {
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (child.closest(SKIP_SELECTOR)) continue;
      if (isBlockElement(child) && hasText(child)) return false; // recurse into it
    }
    return true;
  }

  function collectParagraphs(root, countSkipped = false) {
    const out = [];
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (translatedParagraphs.has(child)) continue;
        if (child.closest(SKIP_SELECTOR)) {
          if (countSkipped && isBlockElement(child) && hasText(child)) stats.skipped++;
          continue;
        }
        if (isUnit(child)) out.push(child);
        else walk(child);
      }
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
    tooltip.style.left = `${Math.min(x, window.innerWidth - width - 16)}px`;
    tooltip.style.top = `${y + 8}px`;
  }

  // --- cache ---------------------------------------------------------------

  async function loadCache() {
    if (cacheLoaded) return cache;
    cacheKey = `wt:cache:${location.href}`;
    try {
      const stored = await chrome.storage.local.get(cacheKey);
      cache = stored[cacheKey] || {};
    } catch {
      cache = {};
    }
    cacheLoaded = true;
    return cache;
  }

  async function saveCache() {
    if (!cacheLoaded) return;
    try {
      await chrome.storage.local.set({ [cacheKey]: cache });
    } catch {
      // quota/write errors — cache is best-effort
    }
  }

  // --- translate & append --------------------------------------------------

  // Append the Chinese below the original element (bilingual). A <span> with
  // display:block is valid inside <p>, <td>, <li>, <h1>, etc., so this never
  // produces invalid markup, and the original — images included — is untouched.
  function appendTranslation(el, translation) {
    const span = document.createElement("span");
    span.className = "web-translator-cn";
    span.textContent = translation;
    el.appendChild(span);
    translatedParagraphs.add(el);
    cnBlocks.set(el, span);
  }

  async function translateUnit(el) {
    const sourceText = el.innerText.trim();
    if (!sourceText || sourceText.length < 2) return; // skip trivial labels

    const c = await loadCache();
    if (c[sourceText]) {
      appendTranslation(el, c[sourceText]);
      stats.cached++;
      return;
    }

    const spinner = document.createElement("span");
    spinner.className = "web-translator-spinner";
    spinner.setAttribute("aria-label", "translating");
    el.appendChild(spinner);

    let translation = null;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "translate-texts",
        texts: [sourceText],
      });
      if (resp && resp.ok && resp.translations && resp.translations[0]) {
        translation = resp.translations[0];
      }
    } catch {
      // fall through — leave the original in place on failure
    }

    spinner.remove();

    if (!translation) {
      stats.failed++;
      return;
    }

    appendTranslation(el, translation);
    c[sourceText] = translation;
    saveCache();
    stats.translated++;
  }

  function enqueue(el) {
    if (!el || !el.isConnected || translatedParagraphs.has(el) || pending.has(el)) return;
    pending.add(el);
    queue.push(el);
    stats.collected++;
    processQueue();
  }

  // Process one unit at a time so the spinner clearly marks the current one.
  async function processQueue() {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const el = queue.shift();
      pending.delete(el);
      if (!el.isConnected || translatedParagraphs.has(el)) continue;
      await translateUnit(el);
    }
    processing = false;
    reportStats();
  }

  function reportStats() {
    const line = `Translated ${stats.translated} · ${stats.cached} cached · ${stats.failed} failed · ${stats.skipped} skipped`;
    showToast(line);
    try {
      chrome.storage.session.set({ "wt:lastStats": { ...stats, line } });
    } catch {
      // storage.session may be unavailable on old Chrome — ignore
    }
  }

  // --- viewport / mutation observers --------------------------------------

  function observeElement(el) {
    if (!el || !el.isConnected || !intersectionObserver) return;
    intersectionObserver.observe(el);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      intersectionObserver.unobserve(entry.target);
      enqueue(entry.target);
    }
  }

  function observeNewNodes(nodes) {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        continue;
      }
      for (const el of collectParagraphs(node)) observeElement(el);
    }
  }

  function startTranslating() {
    if (intersectionObserver) return; // already running

    resetStats();
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
    for (const el of collectParagraphs(root, true)) observeElement(el);

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
  }

  function restorePage() {
    stopTranslating();
    let count = 0;
    for (const [el, span] of cnBlocks) {
      if (span.isConnected) span.remove();
      count++;
    }
    cnBlocks.clear();
    translatedParagraphs = new WeakSet();
    pending = new WeakSet();
    queue = [];
    resetStats();
    showToast(count ? `Removed ${count} translations.` : "Nothing to restore.");
  }

  function resetStats() {
    stats.collected = 0;
    stats.translated = 0;
    stats.cached = 0;
    stats.failed = 0;
    stats.skipped = 0;
  }

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
      if (cnBlocks.size > 0) restorePage();
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
