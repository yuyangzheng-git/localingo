// Lookup card UI shared by the in-page card (inside a shadow root), the side panel
// and the learning center. Built with DOM APIs only: dictionary text and page text
// are always inserted as text, never as HTML.

import { POS_LABELS, chineseSummary, sourceLabels } from "../dict.js";

const KIND_LABEL = { word: "单词", phrase: "短语" };
const VISIBLE_SENSES = 3;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/**
 * Render a lookup result into `root` (an element or shadow root). Returns a small
 * controller: { update(model), destroy() }.
 *
 * model: { lookup, saved: [items], context: {sentence, surface} | null,
 *          prefs: {assist: "zh"|"mixed"|"en"}, busy?: boolean }
 * handlers: { save(entry, sense) -> Promise<result>, undo(result) -> Promise, speak(text),
 *             pin?(), detail?(query), close?(), lookupWord?(word), translate?(text),
 *             saveSentence?(text), installDictionary?() }
 */
export function renderLookupCard(root, model, handlers = {}) {
  const ui = { active: 0, sense: new Map(), expanded: false, showZh: false, saveState: null, saving: false };
  const card = h("section", { class: "ll-card", role: "dialog", "aria-label": "查词结果" });
  root.append(card);

  function render() {
    card.replaceChildren();
    const { lookup } = model;
    if (model.notice) card.append(h("p", { class: "ll-error", role: "status", text: model.notice }));
    if (model.busy || !lookup) {
      card.append(header(model.query || ""), h("div", { class: "ll-skeleton", "aria-busy": "true" }, h("i"), h("i"), h("i")));
      return;
    }
    if (lookup.status === "no-dictionary" && lookup.installing) return renderMessage("离线词典正在自动安装", "第一次使用会下载约 8 MB 的词典，通常十几秒完成，稍后再查一次即可。");
    if (lookup.status === "no-dictionary") return renderMessage("尚未安装离线词典", "安装后即可在本机查词，不需要联网或启动翻译服务。", handlers.installDictionary && h("button", { class: "ll-btn ll-primary", onclick: handlers.installDictionary }, "安装词典"));
    if (lookup.status === "unsupported") return renderUnsupported(lookup);
    if (lookup.status === "not-found") return renderNotFound(lookup);
    renderResult(lookup);
  }

  function header(title, entry, kind) {
    const actions = h("div", { class: "ll-actions" });
    if (entry && handlers.speak) {
      actions.append(h("button", { class: "ll-icon", type: "button", title: "发音", "aria-label": `朗读 ${entry.w}`, onclick: () => handlers.speak(entry.w) }, "▶"));
    }
    if (handlers.pin) actions.append(h("button", { class: "ll-icon ll-text", type: "button", title: "固定到侧栏", onclick: handlers.pin }, "固定到侧栏"));
    if (handlers.close) actions.append(h("button", { class: "ll-icon", type: "button", title: "关闭 (Esc)", "aria-label": "关闭", onclick: handlers.close }, "×"));
    return h(
      "header",
      { class: "ll-head" },
      h("div", { class: "ll-title" }, h("h2", { text: title }), kind ? h("span", { class: "ll-kind", text: KIND_LABEL[kind] || "" }) : null),
      actions,
    );
  }

  function renderMessage(title, body, action) {
    card.append(header(model.lookup?.query || ""), h("div", { class: "ll-message" }, h("strong", { text: title }), h("p", { text: body }), action || null));
  }

  function renderUnsupported(lookup) {
    const actions = h("div", { class: "ll-row" });
    if (lookup.kind === "sentence" || lookup.kind === "too-long") {
      if (handlers.translate) actions.append(h("button", { class: "ll-btn", onclick: () => handlers.translate(lookup.query) }, "翻译这句"));
      if (handlers.saveSentence) actions.append(h("button", { class: "ll-btn", onclick: () => handlers.saveSentence(lookup.query) }, "收藏句子"));
    }
    const text = {
      sentence: "这是一个句子，查词适用于单词和短语。",
      "too-long": "选择的内容太长，适合整句翻译或收藏。",
      chinese: "暂不支持中文反查英文。",
      code: "看起来是代码、链接或变量名，不按英语词条查询。",
      empty: "没有选中文字。",
    }[lookup.kind];
    renderMessage("无法作为词条查询", text || "", actions.childElementCount ? actions : null);
  }

  function renderNotFound(lookup) {
    const body = h("div", { class: "ll-message" }, h("strong", { text: "词典里没有找到这个词条" }), h("p", { text: "可以试试拆开查询，或检查拼写。" }));
    if (lookup.words?.length > 1 && handlers.lookupWord) {
      body.append(h("div", { class: "ll-chips", role: "list" }, lookup.words.map((w) => h("button", { class: "ll-chip", role: "listitem", onclick: () => handlers.lookupWord(w) }, w))));
    }
    if (handlers.translate) body.append(h("button", { class: "ll-btn", onclick: () => handlers.translate(lookup.query) }, "改用翻译"));
    card.append(header(lookup.query), body);
  }

  function renderResult(lookup) {
    const result = lookup.results[Math.min(ui.active, lookup.results.length - 1)];
    const { entry, senses } = result;
    card.append(header(entry.w, entry, lookup.kind));

    const meta = h("div", { class: "ll-meta" });
    if (entry.ph) meta.append(h("span", { class: "ll-ph", text: `/${entry.ph}/` }));
    const labels = sourceLabels(entry);
    if (labels.length) meta.append(h("span", { class: "ll-labels", title: "来自词典来源的标签，不代表你的水平" }, labels.join(" · ")));
    if (meta.childElementCount) card.append(meta);
    if (result.note) card.append(h("p", { class: `ll-note ${result.relation === "guess" ? "ll-guess" : ""}`, text: result.note }));

    if (lookup.results.length > 1) {
      card.append(
        h(
          "div",
          { class: "ll-chips", role: "tablist", "aria-label": "其他候选" },
          lookup.results.map((r, i) =>
            h(
              "button",
              {
                class: `ll-chip ${i === ui.active ? "ll-on" : ""}`,
                role: "tab",
                "aria-selected": String(i === ui.active),
                onclick: () => {
                  ui.active = i;
                  ui.saveState = null;
                  render();
                },
              },
              r.relation === "exact" ? r.entry.w : `${r.entry.w}（${r.relation === "guess" ? "推测" : "原形"}）`,
            ),
          ),
        ),
      );
    }

    const assist = model.prefs?.assist || "mixed";
    const zhFirst = assist === "zh";
    const zhHidden = assist === "en" && !ui.showZh;
    const summary = chineseSummary(entry);
    if (zhFirst && summary.length) card.append(h("p", { class: "ll-zh-summary", text: summary.slice(0, 3).join("；") }));

    const selected = ui.sense.get(entry.k + entry.w) || senses[0]?.id;
    const shown = ui.expanded ? senses : senses.slice(0, VISIBLE_SENSES);
    const list = h("div", { class: "ll-senses", role: "radiogroup", "aria-label": "选择词义" });
    for (const s of shown) {
      const checked = s.id === selected;
      list.append(
        h(
          "label",
          { class: `ll-sense ${checked ? "ll-on" : ""}` },
          h("input", {
            type: "radio",
            name: `ll-sense-${entry.k}`,
            checked,
            onchange: () => {
              ui.sense.set(entry.k + entry.w, s.id);
              ui.saveState = null;
              render();
            },
          }),
          h(
            "span",
            { class: "ll-sense-body" },
            s.pos ? h("span", { class: "ll-pos", text: POS_LABELS[s.pos] || s.pos }) : null,
            zhFirst && s.gloss_zh ? h("span", { class: "ll-zh", text: s.gloss_zh }) : null,
            s.definition_en ? h("span", { class: "ll-en", lang: "en", text: s.definition_en }) : null,
            !zhFirst && s.gloss_zh && !zhHidden ? h("span", { class: "ll-zh", text: s.gloss_zh }) : null,
          ),
        ),
      );
    }
    card.append(list);
    const toggles = h("div", { class: "ll-row ll-quiet" });
    if (senses.length > VISIBLE_SENSES) {
      toggles.append(
        h("button", { class: "ll-link", onclick: () => ((ui.expanded = !ui.expanded), render()) }, ui.expanded ? "收起词义" : `其他词义（${senses.length - VISIBLE_SENSES}）`),
      );
    }
    if (assist === "en" && senses.some((s) => s.gloss_zh)) {
      toggles.append(h("button", { class: "ll-link", onclick: () => ((ui.showZh = !ui.showZh), render()) }, ui.showZh ? "隐藏中文" : "显示中文"));
    }
    if (toggles.childElementCount) card.append(toggles);

    if (model.context?.sentence) {
      card.append(
        h(
          "blockquote",
          { class: "ll-context", lang: "en" },
          h("span", { class: "ll-label", text: "原句" }),
          model.context.sentence,
          handlers.speak ? h("button", { class: "ll-link", onclick: () => handlers.speak(model.context.sentence) }, "朗读原句") : null,
        ),
      );
    }

    const saved = (model.saved || []).filter((i) => i.lexeme_key === entry.k);
    if (saved.length) {
      card.append(
        h(
          "p",
          { class: "ll-saved" },
          `已在生词本：${saved.map((i) => `${i.pos ? (POS_LABELS[i.pos] || i.pos) + " " : ""}${i.user_gloss || i.meaning?.gloss_zh || i.meaning?.definition_en || ""}`.slice(0, 40)).join("；")}`,
          saved.some((i) => i.encounter_count) ? `（${saved.reduce((n, i) => n + (i.encounter_count || 0), 0)} 个语境）` : "",
        ),
      );
    }

    const sense = senses.find((s) => s.id === selected) || senses[0];
    const foot = h("footer", { class: "ll-foot" });
    if (ui.saveState?.ok) {
      const res = ui.saveState.result;
      const label = res.result === "created" ? "已保存" : res.result === "updated" ? "已添加本次语境" : "已在生词本";
      foot.append(
        h("span", { class: "ll-done", role: "status", text: `✓ ${label}` }),
        res.result !== "already_exists" && handlers.undo
          ? h("button", { class: "ll-link", onclick: async () => {
              await handlers.undo(res);
              ui.saveState = null;
              render();
            } }, "撤销")
          : null,
      );
    } else {
      const alreadySense = saved.find((i) => i.sense_ref === sense?.id);
      foot.append(
        h(
          "button",
          {
            class: "ll-btn ll-primary",
            disabled: ui.saving || !sense,
            onclick: async () => {
              if (ui.saving) return;
              ui.saving = true;
              render();
              try {
                ui.saveState = { ok: true, result: await handlers.save(entry, sense, lookup) };
              } catch (err) {
                ui.saveState = { ok: false, error: err?.message || String(err) };
              } finally {
                ui.saving = false;
                render();
              }
            },
          },
          ui.saving ? "保存中…" : alreadySense ? (model.context?.sentence ? "＋ 添加本次语境" : "已在生词本") : "＋ 加入生词本",
        ),
      );
      if (ui.saveState && !ui.saveState.ok) foot.append(h("span", { class: "ll-error", role: "alert", text: `保存失败：${ui.saveState.error}` }));
    }
    if (handlers.detail) foot.append(h("button", { class: "ll-link ll-right", onclick: () => handlers.detail(entry.w) }, "详细 ↗"));
    card.append(foot);
    card.append(h("p", { class: "ll-source", text: "释义来源：ECDICT（英文释义源自 WordNet）" }));
  }

  render();
  return {
    update(next) {
      const sameQuery = next.lookup && model.lookup && next.lookup.query === model.lookup.query;
      model = next;
      if (!sameQuery) {
        ui.active = 0;
        ui.expanded = false;
        ui.saveState = null;
      }
      render();
    },
    destroy() {
      card.remove();
    },
    element: card,
  };
}

/** Translation result view (selection → 翻译), same card frame. */
export function renderTranslationCard(root, state, handlers = {}) {
  const card = h("section", { class: "ll-card", role: "dialog", "aria-label": "翻译结果" });
  const head = h(
    "header",
    { class: "ll-head" },
    h("div", { class: "ll-title" }, h("h2", { text: "翻译" }), h("span", { class: "ll-kind", text: "本地模型" })),
    h("div", { class: "ll-actions" }, handlers.close ? h("button", { class: "ll-icon", type: "button", "aria-label": "关闭", title: "关闭 (Esc)", onclick: handlers.close }, "×") : null),
  );
  card.append(head, h("blockquote", { class: "ll-context", lang: "en", text: state.original }));
  if (state.busy) card.append(h("div", { class: "ll-skeleton", "aria-busy": "true" }, h("i"), h("i")));
  else if (state.error) card.append(h("p", { class: "ll-error", role: "alert", text: `翻译失败：${state.error}` }));
  else card.append(h("p", { class: "ll-translation", lang: "zh-CN", text: state.translation }));
  const foot = h("footer", { class: "ll-foot" });
  if (handlers.saveSentence) foot.append(h("button", { class: "ll-btn", onclick: handlers.saveSentence }, "收藏句子"));
  if (handlers.speak) foot.append(h("button", { class: "ll-link", onclick: () => handlers.speak(state.original) }, "朗读原文"));
  if (foot.childElementCount) card.append(foot);
  root.append(card);
  return { element: card, destroy: () => card.remove() };
}
