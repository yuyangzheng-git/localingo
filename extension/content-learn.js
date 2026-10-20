// Content script: in-page learning layer — selection action bar, lookup card and
// translation card. UI lives in a closed shadow root so page CSS can't change it
// and it can't change the page. Dictionary and vocabulary data stay in the
// extension; this script only sends validated messages to the service worker.
//
// Nothing happens on plain selection beyond showing the small bar (no lookups,
// no network); the card appears only after the user clicks.

(() => {
  if (globalThis.__localingoLearnLoaded) return;
  globalThis.__localingoLearnLoaded = true;

  const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";
  let modules = null; // { card: lookup-card.js, text: text.js }
  let ui = null; // { host, shadow, bar, layer }
  let prefs = { selectionBar: "always", assist: "mixed" };
  let displayMode = "bilingual";
  let requestSeq = 0;
  let active = null; // { kind: "lookup"|"translate", controller, range, rect, query, ... }
  let lastFocus = null;

  // --- setup -------------------------------------------------------------------

  async function loadModules() {
    if (!modules) {
      modules = Promise.all([
        import(chrome.runtime.getURL("learning/ui/lookup-card.js")),
        import(chrome.runtime.getURL("learning/text.js")),
      ]).then(([card, text]) => ({ card, text }));
    }
    return modules;
  }

  async function loadPrefs() {
    try {
      const data = await chrome.storage.sync.get({ learnPrefs: {}, displayMode: "bilingual" });
      prefs = { ...prefs, ...data.learnPrefs };
      displayMode = data.displayMode;
    } catch {
      // keep defaults
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.learnPrefs) prefs = { ...prefs, ...changes.learnPrefs.newValue };
    if (changes.displayMode) displayMode = changes.displayMode.newValue;
  });

  async function ensureUi() {
    if (ui) return ui;
    const host = document.createElement("localingo-learn");
    host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483646;";
    const shadow = host.attachShadow({ mode: "closed" });
    try {
      // Constructed stylesheet: works on pages whose CSP blocks extension <link>s.
      const css = await (await fetch(chrome.runtime.getURL("learning/ui/card.css"))).text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("learning/ui/card.css");
      shadow.append(link);
    }
    const bar = document.createElement("div");
    bar.className = "ll-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "LocaLingo 选词操作");
    bar.hidden = true;
    // Keep the page selection when clicking the bar.
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    const layer = document.createElement("div");
    shadow.append(bar, layer);
    document.documentElement.append(host);
    ui = { host, shadow, bar, layer };
    return ui;
  }

  function isOurs(node) {
    return !!ui && (node === ui.host || ui.host.contains(node));
  }

  // --- selection context ---------------------------------------------------------

  function blockOf(node) {
    let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    while (el && el !== document.body) {
      const d = getComputedStyle(el).display;
      if (d !== "inline" && d !== "contents" && !d.startsWith("inline")) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    if (!el || isOurs(el) || el.closest(EDITABLE)) return null;
    if (el.closest(".web-translator-cn, .web-translator-tooltip")) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, range: range.cloneRange(), rect };
  }

  function contextFor(info, textMod) {
    try {
      const block = blockOf(info.range.startContainer);
      const pre = document.createRange();
      pre.selectNodeContents(block);
      pre.setEnd(info.range.startContainer, info.range.startOffset);
      const start = pre.toString().length;
      const full = block.textContent || "";
      const ctx = textMod.sentenceAround(full, start, start + info.text.length);
      return { ...ctx, surface: textMod.cleanSelection(info.text), url: location.href, title: document.title.slice(0, 300) };
    } catch {
      return { sentence: "", before: "", after: "", surface: info.text.trim(), url: location.href, title: document.title };
    }
  }

  // --- positioning ---------------------------------------------------------------

  function place(el, rect, { gap = 8, preferAbove = false } = {}) {
    const margin = 8;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = Math.max(margin, Math.min(rect.left, window.innerWidth - w - margin));
    const below = rect.bottom + gap;
    const above = rect.top - hgt - gap;
    let top = preferAbove ? (above >= margin ? above : below) : below + hgt <= window.innerHeight - margin ? below : above;
    top = Math.max(margin, Math.min(top, window.innerHeight - hgt - margin));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function anchorRect(range) {
    if (!range || !range.startContainer.isConnected) return null;
    const r = range.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  function reposition() {
    if (!ui) return;
    if (!ui.bar.hidden && ui.barRange) {
      const r = anchorRect(ui.barRange);
      if (!r) hideBar();
      else place(ui.bar, r, { preferAbove: true });
    }
    if (active?.controller) {
      const r = anchorRect(active.range);
      if (!r && active.range) closeCard({ restoreFocus: false });
      else if (r) place(active.controller.element, r);
    }
  }

  // --- action bar ------------------------------------------------------------------

  function hideBar() {
    if (ui) {
      ui.bar.hidden = true;
      ui.barRange = null;
    }
  }

  async function maybeShowBar() {
    if (prefs.selectionBar === "off") return hideBar();
    if (prefs.selectionBar === "learn" && displayMode !== "learn") return hideBar();
    const info = selectionInfo();
    if (!info) return hideBar();
    const { text: textMod } = await loadModules();
    const cls = textMod.classifySelection(info.text);
    const actions =
      cls.kind === "word" || cls.kind === "phrase"
        ? [["查词", () => openLookup(info, cls.text)], ["翻译", () => openTranslate(info)]]
        : cls.kind === "sentence" || cls.kind === "too-long"
          ? [["翻译", () => openTranslate(info)], ["收藏句子", () => saveSentence(info.text.trim())]]
          : [];
    if (!actions.length) return hideBar();
    const { bar } = await ensureUi();
    bar.replaceChildren(
      ...actions.map(([label, fn]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.addEventListener("click", () => {
          hideBar();
          fn();
        });
        return b;
      }),
    );
    bar.hidden = false;
    ui.barRange = info.range;
    place(bar, info.rect, { preferAbove: true });
  }

  // --- cards -------------------------------------------------------------------------

  function closeCard({ restoreFocus = true } = {}) {
    if (!active) return;
    active.controller?.destroy();
    active = null;
    requestSeq++; // late responses for the closed card are ignored
    if (restoreFocus && lastFocus && lastFocus.isConnected) {
      try {
        lastFocus.focus({ preventScroll: true });
      } catch {
        // not focusable any more
      }
    }
    lastFocus = null;
  }

  async function send(message) {
    try {
      const resp = await chrome.runtime.sendMessage(message);
      if (!resp) throw new Error("扩展没有响应，请刷新页面后重试");
      return resp;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function openLookup(info, query, context) {
    const { card, text: textMod } = await loadModules();
    await ensureUi();
    const prevRange = active?.range || null;
    closeCard({ restoreFocus: false });
    lastFocus = document.activeElement;
    const ctx = context || (info ? contextFor(info, textMod) : null);
    const id = ++requestSeq;
    const cardKey = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let saveRound = 0;
    let model = { query, busy: true, context: ctx, prefs };
    const handlers = {
      save: async (entry, sense, lookup) => {
        const resp = await send({
          type: "learning:save",
          payload: {
            idempotency_key: `${cardKey}:${saveRound}:${sense.id}`,
            headword: entry.w,
            lexeme_key: entry.k,
            kind: lookup.kind === "phrase" || entry.k.includes(" ") ? "phrase" : "word",
            sense,
            source: { id: "ecdict", version: model.dictionaryVersion || null },
            context: ctx ? { surface: ctx.surface, sentence: ctx.sentence, before: ctx.before, after: ctx.after, url: ctx.url, title: ctx.title } : null,
          },
        });
        if (!resp.ok) throw new Error(resp.error);
        refreshSaved();
        return resp;
      },
      undo: async (res) => {
        saveRound++;
        await send({ type: "learning:undo", item_id: res.item_id, encounter_id: res.encounter_id, result: res.result });
        refreshSaved();
      },
      speak: async (t) => {
        const resp = await send({ type: "learning:speak", text: t });
        if (!resp.ok) {
          model = { ...model, notice: resp.error };
          active?.controller?.update(model);
        }
      },
      pin: () => send({ type: "learning:pin", model: { lookup: model.lookup, saved: model.saved, context: ctx } }),
      detail: (q) => send({ type: "learning:open-center", hash: `#lookup?q=${encodeURIComponent(q)}` }),
      close: () => closeCard(),
      lookupWord: (w) => openLookup(null, w, ctx),
      translate: (t) => openTranslate(info, t),
      saveSentence: (t) => saveSentence(t),
      installDictionary: () => send({ type: "learning:open-center", hash: "#settings" }),
    };
    const controller = card.renderLookupCard(ui.layer, model, handlers);
    controller.element.classList.add("ll-floating");
    active = { kind: "lookup", controller, range: info?.range || prevRange };
    const rect = (info && anchorRect(info.range)) || { left: window.innerWidth / 2 - 180, top: 80, bottom: 80, right: 0 };
    place(controller.element, rect);
    controller.element.tabIndex = -1;
    controller.element.focus({ preventScroll: true });

    async function refreshSaved() {
      const resp = await send({ type: "learning:lookup", request_id: id, query });
      if (resp.ok && active?.controller === controller) {
        model = { ...model, saved: resp.saved };
        controller.update(model);
      }
    }

    const resp = await send({ type: "learning:lookup", request_id: id, query });
    if (id !== requestSeq || active?.controller !== controller) return; // a newer lookup replaced this one
    if (!resp.ok) {
      model = { ...model, busy: false, lookup: { status: "not-found", kind: "word", query, results: [], words: [] }, notice: resp.error };
    } else {
      prefs = { ...prefs, ...resp.prefs };
      model = { ...model, busy: false, lookup: resp.lookup, saved: resp.saved, prefs, dictionaryVersion: resp.dictionary_version };
    }
    controller.update(model);
    place(controller.element, anchorRect(active.range) || rect);
  }

  async function openTranslate(info, textOverride) {
    const { card } = await loadModules();
    await ensureUi();
    const prevRange = active?.range || null;
    closeCard({ restoreFocus: false });
    lastFocus = document.activeElement;
    const original = (textOverride || info?.text || "").trim();
    if (!original) return;
    const id = ++requestSeq;
    const handlers = {
      close: () => closeCard(),
      saveSentence: () => saveSentence(original),
      speak: (t) => send({ type: "learning:speak", text: t }),
    };
    let controller = card.renderTranslationCard(ui.layer, { original, busy: true }, handlers);
    controller.element.classList.add("ll-floating");
    active = { kind: "translate", controller, range: info?.range || prevRange };
    const rect = (info && anchorRect(info.range)) || { left: window.innerWidth / 2 - 180, top: 80, bottom: 80 };
    place(controller.element, rect);
    const resp = await send({ type: "translate-texts", texts: [original.slice(0, 4000)] });
    if (id !== requestSeq || active?.controller !== controller) return;
    controller.destroy();
    const state = resp.ok && resp.translations?.[0] ? { original, translation: resp.translations[0] } : { original, error: resp.error || "翻译服务没有返回结果" };
    controller = card.renderTranslationCard(ui.layer, state, handlers);
    controller.element.classList.add("ll-floating");
    active = { kind: "translate", controller, range: active.range };
    place(controller.element, anchorRect(active.range) || rect);
  }

  async function saveSentence(text) {
    const resp = await send({
      type: "learning:save-sentence",
      payload: { idempotency_key: `${location.href}::${text}`.slice(0, 100) + `:${text.length}`, text: text.slice(0, 1200), url: location.href, title: document.title.slice(0, 300) },
    });
    const toast = globalThis.__localingoCore?.showToast;
    if (toast) toast(resp.ok ? (resp.result === "already_exists" ? "这句已经收藏过了" : "已收藏句子，可在学习中心查看") : `收藏失败：${resp.error}`, resp.ok ? "success" : "error");
  }

  // --- events ------------------------------------------------------------------------

  let barTimer = null;
  function scheduleBar() {
    clearTimeout(barTimer);
    barTimer = setTimeout(() => maybeShowBar().catch(() => {}), 120);
  }

  document.addEventListener("mouseup", (e) => {
    if (isOurs(e.target)) return;
    scheduleBar();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift" || e.shiftKey) scheduleBar();
  });
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (ui && !ui.bar.hidden && (!sel || sel.isCollapsed)) hideBar();
  });
  document.addEventListener(
    "mousedown",
    (e) => {
      if (isOurs(e.target)) return;
      hideBar();
      if (active) closeCard({ restoreFocus: false });
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (active) {
        e.stopPropagation();
        closeCard();
      } else hideBar();
    },
    true,
  );
  window.addEventListener("scroll", () => requestAnimationFrame(reposition), { passive: true, capture: true });
  window.addEventListener("resize", () => requestAnimationFrame(reposition), { passive: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "learning:page-info") {
      sendResponse({ url: location.href, title: document.title });
      return;
    }
    if (message?.type !== "learning:show-lookup") return;
    (async () => {
      const info = selectionInfo();
      const raw = message.text || info?.text || "";
      const { text: textMod } = await loadModules();
      const cls = textMod.classifySelection(raw);
      if (cls.kind === "sentence" || cls.kind === "too-long") await openTranslate(info, raw);
      else if (raw.trim()) await openLookup(info, cls.text || raw.trim());
      sendResponse({ ok: true });
    })();
    return true;
  });

  loadPrefs();
})();
