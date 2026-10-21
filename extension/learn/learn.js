// LocaLingo learning center. Runs as the extension's full-tab page and as the hosted
// web app (see learning/env.js for the differences). Everything except lookup needs a
// signed-in LocaLingo account.

import { POS_LABELS } from "../learning/dict.js";
import { removeDictionary, storageEstimate } from "../learning/dict-idb.js";
import { createEnv, isExtension } from "../learning/env.js";
import { ankiTsv, backupFileName, downloadText } from "../learning/export.js";
import { RATING_LABELS, formatInterval, previewIntervals } from "../learning/scheduler.js";
import { ApiClient } from "../learning/sync.js";
import { cardHandlers, lookupWithSaved } from "../learning/ui/actions.js";
import { renderLookupCard } from "../learning/ui/lookup-card.js";

const env = createEnv();
const store = env.store;
const $ = (id) => document.getElementById(id);
const PAGES = ["login", "words", "sentences", "review", "lookup", "settings"];
const PUBLIC_PAGES = ["login", "lookup"];
let signedIn = false;
let prefs = await env.getPrefs();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// --- helpers -------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function say(id, text, kind = "") {
  const el = $(id);
  el.textContent = text || "";
  el.dataset.kind = kind;
}

const fmtDate = new Intl.DateTimeFormat("zh-CN", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "numeric", day: "numeric" });

function relativeDue(ms) {
  if (ms == null) return "新词";
  const diff = ms - Date.now();
  if (diff <= 0) return "待复习";
  return `${formatInterval(diff)}后复习`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function safeHttpUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Link to the source with a Text Fragment so Chrome scrolls to and highlights the
 *  quote if it's still there (and silently ignores it when the page changed). */
function sourceLink(url, sentence) {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  if (!sentence) return safe;
  const words = sentence.replace(/\s+/g, " ").trim().split(" ");
  const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C");
  const frag = words.length > 10 ? `${enc(words.slice(0, 5).join(" "))},${enc(words.slice(-4).join(" "))}` : enc(words.join(" "));
  return `${safe.split("#")[0]}#:~:text=${frag}`;
}

/** Sentence with the target expression marked (text nodes only, never HTML). */
function markedSentence(sentence, target) {
  const frag = document.createDocumentFragment();
  const i = target ? sentence.toLowerCase().indexOf(target.toLowerCase()) : -1;
  if (i < 0) {
    frag.append(sentence);
    return frag;
  }
  frag.append(sentence.slice(0, i), h("mark", { text: sentence.slice(i, i + target.length) }), sentence.slice(i + target.length));
  return frag;
}

function meaningNodes(meaning, userGloss, pos) {
  const zh = meaning?.gloss_zh;
  const en = meaning?.definition_en;
  const box = h("div", { class: "meaning-lines" });
  if (userGloss) box.append(h("p", { class: "mine" }, h("span", { class: "tag", text: "我的释义" }), userGloss));
  const lines = prefs.assist === "zh" ? [zh, en] : [en, zh];
  const posLabel = pos ? h("span", { class: "pos", text: POS_LABELS[pos] || pos }) : null;
  let first = true;
  for (const line of lines) {
    if (!line) continue;
    box.append(h("p", { lang: line === en ? "en" : "zh-CN", class: line === en ? "en" : "zh" }, first ? posLabel : null, line));
    first = false;
  }
  return box;
}

function changed() {
  env.notifyChange();
  refreshBadges();
}

// --- routing ---------------------------------------------------------------------------

function parseHash() {
  const raw = location.hash.slice(1) || "words";
  if (raw.startsWith("item=")) return { page: "words", item: decodeURIComponent(raw.slice(5)) };
  const [page, query = ""] = raw.split("?");
  return { page: PAGES.includes(page) ? page : "words", params: new URLSearchParams(query) };
}

async function route() {
  signedIn = (await env.sync.status()).configured;
  const r = parseHash();
  if (r.page === "login" && signedIn) return void (location.hash = "#words");
  // Signed out: keep the requested address so signing in lands there.
  if (!signedIn && !PUBLIC_PAGES.includes(r.page)) return showPage("login");
  showPage(r.page);
  if (r.page === "words") {
    await loadWords(true);
    if (r.item) openItem(r.item);
  } else if (r.page === "sentences") loadSentences();
  else if (r.page === "review") showReviewStart();
  else if (r.page === "lookup") {
    const q = r.params?.get("q");
    if (q) runLookup(q);
    $("lookupQ").focus();
    if (env.kind === "extension") loadDictionary();
  } else if (r.page === "settings") loadSettings();
}

function showPage(name) {
  for (const p of PAGES) $(`page-${p}`).hidden = p !== name;
  for (const a of document.querySelectorAll("#nav [data-auth]")) a.hidden = !signedIn;
  for (const a of document.querySelectorAll("#nav [data-guest]")) a.hidden = signedIn;
  for (const a of document.querySelectorAll("#nav a")) {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $("onboard").hidden = name !== "words" || prefs.onboarded;
  document.title = `LocaLingo · ${{ login: "登录", words: "生词与词组", sentences: "收藏句子", review: "今日复习", lookup: "查词", settings: "设置" }[name]}`;
}

window.addEventListener("hashchange", route);

// --- sign in -----------------------------------------------------------------------------

function afterSignIn() {
  if (!location.hash || location.hash === "#login") location.hash = "#words";
  else route();
  refreshSyncState();
  refreshBadges();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("loginMsg", "正在登录…");
  $("loginBtn").disabled = true;
  try {
    await env.sync.signIn($("loginUser").value.trim(), $("loginPassword").value);
    $("loginPassword").value = "";
    say("loginMsg", "");
    afterSignIn();
  } catch (err) {
    say("loginMsg", err.message, "error");
  } finally {
    $("loginBtn").disabled = false;
  }
});

$("signupBtn").addEventListener("click", async () => {
  say("loginMsg", "正在注册…");
  $("signupBtn").disabled = true;
  try {
    await env.sync.signUp($("loginUser").value.trim().toLowerCase(), $("loginPassword").value);
    $("loginPassword").value = "";
    say("loginMsg", "");
    afterSignIn();
  } catch (err) {
    say("loginMsg", err.message, "error");
  } finally {
    $("signupBtn").disabled = false;
  }
});

fetch(`${env.server}/api/health`, { credentials: "omit" })
  .then((r) => r.json())
  .then((d) => {
    $("signupBtn").hidden = !d.signup;
    $("signupHint").hidden = !d.signup;
  })
  .catch(() => {});

if (env.kind === "web") {
  env.onSynced = () => {
    refreshSyncState();
    // Pulled changes may affect what's on screen.
    if (!$("page-words").hidden && !$("itemDialog").open) loadWords(true);
    refreshBadges();
  };
  env.signedOut = () => {
    location.hash = "#login";
    route();
  };
  for (const el of document.querySelectorAll("[data-ext-only]")) el.hidden = true;
}

// --- onboarding -----------------------------------------------------------------------------

$("obAssist").value = prefs.assist;
$("obSave").addEventListener("click", async () => {
  prefs = await env.setPrefs({ assist: $("obAssist").value, dailyNew: Number($("obDaily").value), readingDomain: $("obDomain").value, onboarded: true });
  $("onboard").hidden = true;
});
$("obSkip").addEventListener("click", async () => {
  prefs = await env.setPrefs({ onboarded: true });
  $("onboard").hidden = true;
});

// --- words ------------------------------------------------------------------------------------

const wordFilter = { q: "", status: "", tag: "", site: "", due: false, sort: "recent", trash: false, offset: 0 };

async function loadFacets() {
  const f = await store.facets();
  const fill = (sel, rows, all) => {
    const cur = sel.value;
    sel.replaceChildren(h("option", { value: "" }, all), ...rows.map(([v, n]) => h("option", { value: v }, `${v}（${n}）`)));
    sel.value = rows.some(([v]) => v === cur) ? cur : "";
  };
  fill($("wordTag"), f.tags, "全部标签");
  fill($("wordSite"), f.sites, "全部来源");
}

async function loadWords(reset) {
  if (reset) wordFilter.offset = 0;
  const res = await store.listItems({ ...wordFilter, limit: 50 });
  if (reset) $("wordList").replaceChildren();
  $("wordList").append(...res.items.map(wordCard));
  $("wordMore").hidden = res.next_offset == null;
  wordFilter.next = res.next_offset;
  $("wordCount").textContent = wordFilter.trash ? `回收区 ${res.total} 条（30 天后自动清除）` : `${res.total} 条`;
  $("wordEmpty").hidden = res.total > 0 || wordFilter.trash || !!wordFilter.q;
  if (reset) loadFacets();
}

function wordCard(item) {
  const enc = item.last_encounter;
  const li = h("li", { class: `card ${item.status !== "learning" ? "muted-card" : ""}` });
  const head = h(
    "div",
    { class: "card-head" },
    h("h3", { lang: "en", text: item.headword }),
    item.status === "familiar" ? h("span", { class: "chip", text: "熟悉" }) : item.status === "paused" ? h("span", { class: "chip", text: "暂停" }) : null,
    h("span", { class: "card-due", text: item.card_state ? relativeDue(item.card_state.stage === "new" ? null : item.card_state.due_at) : "" }),
  );
  li.append(head, meaningNodes(item.meaning, item.user_gloss, item.pos));
  if (enc?.sentence) li.append(h("p", { class: "quote", lang: "en" }, markedSentence(enc.sentence, enc.surface_form || item.headword)));
  const meta = [enc?.source_url ? hostOf(enc.source_url) : "", item.encounter_count > 1 ? `${item.encounter_count} 个语境` : "", (item.tags || []).map((t) => `#${t}`).join(" ")].filter(Boolean).join(" · ");
  if (meta) li.append(h("p", { class: "meta", text: meta }));
  if (wordFilter.trash) {
    li.append(
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", type: "button", onclick: async () => {
          try {
            await store.restoreItem(item.id);
            changed();
            loadWords(true);
          } catch (err) {
            alert(err.message);
          }
        } }, "恢复"),
        h("button", { class: "btn danger", type: "button", onclick: async () => {
          if (!confirm(`永久删除「${item.headword}」及其语境和复习记录？此操作无法撤销。`)) return;
          await store.purgeTrash({ ids: [item.id] });
          changed();
          loadWords(true);
        } }, "永久删除"),
      ),
    );
  } else {
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `编辑 ${item.headword}`);
    li.addEventListener("click", () => (location.hash = `#item=${encodeURIComponent(item.id)}`));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        location.hash = `#item=${encodeURIComponent(item.id)}`;
      }
    });
  }
  return li;
}

let wordTimer;
$("wordQ").addEventListener("input", () => {
  clearTimeout(wordTimer);
  wordTimer = setTimeout(() => {
    wordFilter.q = $("wordQ").value;
    loadWords(true);
  }, 200);
});
for (const [id, key] of [["wordStatus", "status"], ["wordTag", "tag"], ["wordSite", "site"], ["wordSort", "sort"]]) {
  $(id).addEventListener("change", () => {
    wordFilter[key] = $(id).value;
    loadWords(true);
  });
}
$("wordDue").addEventListener("change", () => {
  wordFilter.due = $("wordDue").checked;
  loadWords(true);
});
$("wordMore").addEventListener("click", () => {
  wordFilter.offset = wordFilter.next;
  loadWords(false);
});
$("trashToggle").addEventListener("click", () => {
  wordFilter.trash = !wordFilter.trash;
  $("trashToggle").setAttribute("aria-pressed", String(wordFilter.trash));
  $("trashToggle").textContent = wordFilter.trash ? "返回生词本" : "回收区";
  loadWords(true);
});

// --- item dialog -------------------------------------------------------------------------------

let openItemId = null;

async function openItem(id) {
  const data = await store.getItem(id);
  if (!data || data.item.deleted_at) {
    location.hash = "#words";
    return;
  }
  openItemId = id;
  const { item, encounters, card, review_count } = data;
  $("itemTitle").textContent = item.headword;
  $("itemTitle").lang = "en";
  $("itemMeta").textContent = [
    item.kind === "phrase" ? "短语" : "单词",
    item.meaning_source === "dictionary" ? `词典释义 · ${item.source_id || ""}` : item.meaning_source === "ai" ? "AI 释义" : "自定义释义",
    `收藏于 ${fmtDay.format(item.created_at)}`,
    card ? (card.state.stage === "new" ? "尚未复习" : `已复习 ${review_count} 次 · ${relativeDue(card.state.due_at)}`) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("itemMeaning").replaceChildren(meaningNodes(item.meaning, null, item.pos));
  $("itemGloss").value = item.user_gloss || "";
  $("itemNote").value = item.note || "";
  $("itemTags").value = (item.tags || []).join(", ");
  for (const r of document.querySelectorAll("#itemStatus input")) r.checked = r.value === item.status;
  const contexts = encounters.filter((e) => e.sentence || e.source_url); // lookups without a page add no context
  $("itemEncounters").replaceChildren(
    ...(contexts.length
      ? contexts.map((e) => {
          const link = sourceLink(e.source_url, e.sentence);
          return h(
            "li",
            {},
            e.sentence ? h("p", { class: "quote", lang: "en" }, markedSentence(e.sentence, e.surface_form)) : h("p", { class: "muted", text: "未关联原句" }),
            h(
              "p",
              { class: "meta" },
              link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer", text: e.source_title || hostOf(e.source_url) }) : null,
              ` · ${fmtDate.format(e.seen_at)} `,
              h("button", { class: "link", type: "button", onclick: async () => {
                if (!confirm("删除这条语境？")) return;
                await store.deleteEncounter(e.id);
                changed();
                openItem(id);
              } }, "删除语境"),
            ),
          );
        })
      : [h("li", { class: "muted", text: "没有记录语境" })]),
  );
  say("itemMsg", "");
  if (!$("itemDialog").open) $("itemDialog").showModal();
}

$("itemDialog").addEventListener("close", () => {
  openItemId = null;
  if (location.hash.startsWith("#item=")) history.replaceState(null, "", "#words");
});

$("itemSave").addEventListener("click", async () => {
  if (!openItemId) return;
  try {
    await store.updateItem(openItemId, {
      user_gloss: $("itemGloss").value,
      note: $("itemNote").value,
      tags: $("itemTags").value.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
      status: document.querySelector("#itemStatus input:checked")?.value || "learning",
    });
    changed();
    say("itemMsg", "已保存", "ok");
    loadWords(true);
  } catch (err) {
    say("itemMsg", err.message, "error");
  }
});

$("itemDelete").addEventListener("click", async () => {
  if (!openItemId) return;
  const id = openItemId;
  await store.deleteItem(id);
  changed();
  $("itemDialog").close();
  loadWords(true);
  toast("已移到回收区", "撤销", async () => {
    await store.restoreItem(id);
    changed();
    loadWords(true);
  });
});

function toast(text, actionLabel, action) {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, text, actionLabel ? h("button", { class: "link", type: "button", onclick: () => (el.remove(), action()) }, actionLabel) : null);
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// --- sentences ----------------------------------------------------------------------------------

let sentTrash = false;

async function loadSentences() {
  const res = await store.listSentences({ q: $("sentQ").value, trash: sentTrash });
  $("sentList").replaceChildren(
    ...res.sentences.map((s) => {
      const note = h("textarea", { rows: 2, maxlength: 4000, "aria-label": "笔记" });
      note.value = s.note || "";
      const link = sourceLink(s.source_url, s.text);
      const actions = sentTrash
        ? [
            h("button", { class: "btn", type: "button", onclick: async () => {
              await store.restoreSentence(s.id);
              changed();
              loadSentences();
            } }, "恢复"),
          ]
        : [
            h("button", { class: "btn", type: "button", onclick: async () => {
              await store.updateSentence(s.id, { note: note.value });
              changed();
              toast("笔记已保存");
            } }, "保存笔记"),
            h("button", { class: "btn", type: "button", onclick: () => env.speak(s.text) }, "朗读"),
            h("button", { class: "btn danger", type: "button", onclick: async () => {
              await store.deleteSentence(s.id);
              changed();
              loadSentences();
              toast("已移到回收区", "撤销", async () => {
                await store.restoreSentence(s.id);
                changed();
                loadSentences();
              });
            } }, "删除"),
          ];
      return h(
        "li",
        { class: "card" },
        h("p", { class: "sentence", lang: "en", text: s.text }),
        h("p", { class: "meta" }, link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer", text: s.source_title || hostOf(s.source_url) }) : "未关联来源", ` · ${fmtDay.format(s.created_at)}`),
        sentTrash ? null : note,
        h("div", { class: "row" }, actions),
      );
    }),
  );
  $("sentEmpty").hidden = res.total > 0 || sentTrash || !!$("sentQ").value;
}

$("sentQ").addEventListener("input", () => {
  clearTimeout(wordTimer);
  wordTimer = setTimeout(loadSentences, 200);
});
$("sentTrashToggle").addEventListener("click", () => {
  sentTrash = !sentTrash;
  $("sentTrashToggle").setAttribute("aria-pressed", String(sentTrash));
  $("sentTrashToggle").textContent = sentTrash ? "返回句子" : "回收区";
  loadSentences();
});

// --- review --------------------------------------------------------------------------------------

const review = { session: null, current: null, shownAt: 0, revealedAt: 0, eventId: null, rated: 0, total: 0, busy: false };

async function showReviewStart() {
  const s = await store.reviewSummary({ dailyNew: prefs.dailyNew });
  $("reviewStart").hidden = false;
  $("reviewCard").hidden = true;
  $("reviewDone").hidden = true;
  $("reviewEnd").hidden = true;
  $("reviewProgress").textContent = "";
  $("reviewSummary").textContent = s.today_total
    ? `今天有 ${s.due} 条到期复习${s.new_available ? `，可学习 ${s.new_available} 个新词` : ""}。`
    : s.next_due_at
      ? `今天没有需要复习的内容。下一条将在 ${fmtDate.format(s.next_due_at)} 到期。`
      : "还没有可复习的内容。先在网页上收藏几个生词吧。";
  $("reviewBegin").hidden = !s.today_total;
  review.total = s.today_total;
}

$("reviewBegin").addEventListener("click", () => {
  review.session = crypto.randomUUID();
  review.rated = 0;
  nextReview();
});
$("reviewAgain").addEventListener("click", showReviewStart);
$("reviewEnd").addEventListener("click", () => finishReview("你可以随时回来继续。"));

async function nextReview() {
  const next = await store.nextCard({ sessionId: review.session, dailyNew: prefs.dailyNew, sessionMax: prefs.sessionMax });
  if (!next.card) {
    return finishReview(next.reason === "session-limit" ? `本次已复习 ${next.rated} 条，达到单次上限。` : review.rated ? `本次复习了 ${review.rated} 条。` : "现在没有到期的卡片。");
  }
  review.current = next;
  review.shownAt = Date.now();
  review.revealedAt = 0;
  review.eventId = crypto.randomUUID();
  $("reviewStart").hidden = true;
  $("reviewDone").hidden = true;
  $("reviewCard").hidden = false;
  $("reviewEnd").hidden = false;
  $("reviewAnswer").hidden = true;
  $("reviewReveal").hidden = false;
  $("reviewInput").value = "";
  $("reviewProgress").textContent = `${review.rated + 1} / ${Math.max(review.total, review.rated + 1)}`;
  const { item, encounter } = next;
  if (encounter?.sentence) {
    $("reviewPrompt").replaceChildren(markedSentence(encounter.sentence, encounter.surface_form || item.headword));
    $("reviewAsk").textContent = `先想一想，「${encounter.surface_form || item.headword}」在这句话中是什么意思？`;
  } else {
    $("reviewPrompt").replaceChildren(h("strong", { class: "big-word", text: item.headword }));
    $("reviewAsk").textContent = "先想一想它的意思（未关联原句）。";
  }
  $("reviewCard").focus();
}

function reveal() {
  if (!review.current || review.revealedAt) return;
  review.revealedAt = Date.now();
  const { item, card, encounter } = review.current;
  $("reviewMeaning").replaceChildren(meaningNodes(card.answer, card.answer.user_gloss || item.user_gloss, card.answer.pos));
  if (item.note) $("reviewMeaning").append(h("p", { class: "note", text: `笔记：${item.note}` }));
  $("reviewSource").textContent = encounter?.source_title ? `来源：${encounter.source_title}` : "";
  const intervals = previewIntervals(card.state, Date.now());
  $("reviewRatings").replaceChildren(
    ...[1, 2, 3, 4].map((r) =>
      h("button", { class: `btn rate r${r}`, type: "button", "data-rating": r, onclick: () => rate(r) }, h("span", { text: `${RATING_LABELS[r]} · ${r}` }), h("small", { text: formatInterval(intervals[r]) })),
    ),
  );
  $("reviewAnswer").hidden = false;
  $("reviewReveal").hidden = true;
  $("reviewRatings").querySelector("[data-rating='3']").focus();
}

async function rate(rating) {
  if (!review.current || !review.revealedAt || review.busy) return;
  review.busy = true;
  try {
    await store.rate({
      event_id: review.eventId,
      card_id: review.current.card.id,
      session_id: review.session,
      rating,
      shown_at: review.shownAt,
      revealed_at: review.revealedAt,
      typed_answer: !!$("reviewInput").value.trim(),
      hint_used: false,
    });
    review.rated++;
    changed();
    await nextReview();
  } catch (err) {
    alert(`评分未保存：${err.message}`);
  } finally {
    review.busy = false;
  }
}

function finishReview(text) {
  review.current = null;
  $("reviewCard").hidden = true;
  $("reviewEnd").hidden = true;
  $("reviewDone").hidden = false;
  $("reviewDoneText").textContent = text;
  $("reviewProgress").textContent = "";
  refreshBadges();
}

$("reviewReveal").addEventListener("click", reveal);
$("reviewSpeak").addEventListener("click", () => {
  const { item, encounter } = review.current || {};
  if (item) env.speak(encounter?.sentence || item.headword);
});
// Shortcuts only while the card has focus, and never while typing in the input.
$("reviewCard").addEventListener("keydown", (e) => {
  if (e.target === $("reviewInput") || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === " " && !review.revealedAt) {
    e.preventDefault();
    reveal();
  } else if (["1", "2", "3", "4"].includes(e.key) && review.revealedAt) {
    e.preventDefault();
    rate(Number(e.key));
  }
});
$("reviewInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    reveal();
  }
});

// --- lookup ------------------------------------------------------------------------------------------

let lookupController = null;
let lookupSeq = 0;

async function runLookup(q) {
  q = q.trim();
  if (!q) return;
  $("lookupQ").value = q;
  const id = ++lookupSeq;
  lookupController?.destroy();
  let model = { query: q, busy: true, prefs };
  const controller = renderLookupCard($("lookupCard"), model, {
    ...cardHandlers(env, {
      refresh: async () => {
        model = { ...model, saved: (await lookupWithSaved(env, q)).saved };
        controller.update(model);
        refreshBadges();
      },
      onLookup: (w) => runLookup(w),
    }),
    installDictionary: () => (location.hash = "#settings"),
  });
  lookupController = controller;
  try {
    const data = await lookupWithSaved(env, q);
    if (id !== lookupSeq) return;
    model = { ...data, query: q, prefs, context: null };
  } catch (err) {
    if (id !== lookupSeq) return;
    model = { query: q, prefs, lookup: { status: "not-found", kind: "word", query: q, results: [], words: [] }, notice: `查询失败：${err.message}` };
  }
  controller.update(model);
}

$("lookupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  history.replaceState(null, "", `#lookup?q=${encodeURIComponent($("lookupQ").value.trim())}`);
  runLookup($("lookupQ").value);
});

// --- settings ------------------------------------------------------------------------------------------

async function loadSettings() {
  prefs = await env.getPrefs();
  $("pAssist").value = prefs.assist;
  $("pBar").value = prefs.selectionBar;
  $("pDaily").value = prefs.dailyNew;
  $("pSession").value = prefs.sessionMax;
  $("pRate").value = String(prefs.speechRate);
  $("pRemote").checked = prefs.allowRemoteVoices;
  loadVoices();
  refreshSyncPanel();
  const est = await storageEstimate();
  $("storageInfo").textContent = est ? `本浏览器已使用约 ${(est.usage / 1e6).toFixed(1)} MB 存储（含离线词典）。` : "";
}

async function loadVoices() {
  const voices = await env.voices().catch(() => []);
  $("pVoice").replaceChildren(h("option", { value: "" }, "自动选择本地英语声音"), ...voices.map((v) => h("option", { value: v.name }, `${v.name}（${v.lang}${v.remote ? " · 在线" : ""}）`)));
  $("pVoice").value = voices.some((v) => v.name === prefs.voiceName) ? prefs.voiceName : "";
  $("voiceHint").textContent = voices.length
    ? ""
    : "没有检测到本地英语声音。macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，添加英语声音后重新打开此页。";
}

async function savePrefs(patch) {
  try {
    prefs = await env.setPrefs(patch);
    say("prefsMsg", "已保存", "ok");
    refreshBadges();
  } catch (err) {
    say("prefsMsg", err.message, "error");
  }
}

$("pAssist").addEventListener("change", () => savePrefs({ assist: $("pAssist").value }));
$("pBar").addEventListener("change", () => savePrefs({ selectionBar: $("pBar").value }));
$("pDaily").addEventListener("change", () => savePrefs({ dailyNew: Number($("pDaily").value) }));
$("pSession").addEventListener("change", () => savePrefs({ sessionMax: Number($("pSession").value) }));
$("pRate").addEventListener("change", () => savePrefs({ speechRate: Number($("pRate").value) }));
$("pVoice").addEventListener("change", () => savePrefs({ voiceName: $("pVoice").value }));
$("pRemote").addEventListener("change", async () => {
  await savePrefs({ allowRemoteVoices: $("pRemote").checked });
  loadVoices();
});

// Dictionary (extension only)

let importWorker = null;

async function loadDictionary() {
  const info = await env.dictionary.info();
  $("dictStatus").textContent = info
    ? `已安装：${info.package_id}（${info.entries?.toLocaleString()} 个词条，ECDICT ${String(info.source_version).slice(0, 7)}），导入于 ${fmtDay.format(new Date(info.imported_at))}。`
    : await autoInstallText();
  $("dictRemove").hidden = !info;
  try {
    // Dictionary packages are public: installing one needs no account.
    const data = await dictApi().get("/api/dict/info");
    $("dictPackages").replaceChildren(
      ...data.packages.map((p) => h("option", { value: p.file, "data-sha": p.sha256 }, `${p.variant === "full" ? "完整包" : "基础包"} · ${p.entries.toLocaleString()} 词条 · ${(p.bytes / 1e6).toFixed(1)} MB`)),
    );
    $("dictServerRow").hidden = !data.packages.length;
  } catch {
    $("dictServerRow").hidden = true; // server unreachable: file import still works
  }
}

// The background installs the base package by itself; show where it is.
async function autoInstallText() {
  chrome.runtime.sendMessage({ type: "learning:install-dictionary" }).catch(() => {});
  const { dictInstall: p } = await chrome.storage.local.get("dictInstall");
  if (p?.state === "error") return `离线词典自动安装失败：${p.error}。可以点下方按钮重试，或导入词典包文件（.jsonl.gz）。`;
  if (p?.state === "importing" && p.total) return `正在自动安装离线词典… ${Math.round((p.done / p.total) * 100)}%`;
  return "正在自动下载离线词典（约 8 MB），完成后查词完全在本机进行。";
}

function dictApi() {
  return new ApiClient({ baseUrl: env.server, timeoutMs: 120000 });
}

function runImport(buffer, expectedSha256) {
  importWorker?.terminate();
  importWorker = new Worker(new URL("./dict-import-worker.js", import.meta.url), { type: "module" });
  $("dictProgress").hidden = false;
  say("dictMsg", "");
  const started = performance.now();
  importWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") {
      $("dictBar").max = m.total || 1;
      $("dictBar").value = m.done;
      $("dictProgressText").textContent = { verify: "校验文件…", import: `写入 ${m.done.toLocaleString()} / ${m.total.toLocaleString()}`, cleanup: "清理旧版本…", done: "完成" }[m.phase] || "";
    } else {
      $("dictProgress").hidden = true;
      importWorker.terminate();
      importWorker = null;
      if (m.type === "done") say("dictMsg", `词典已安装（用时 ${((performance.now() - started) / 1000).toFixed(0)} 秒）。`, "ok");
      else say("dictMsg", m.cancelled ? "已取消导入，原有词典保持不变。" : `导入失败：${m.message}`, m.cancelled ? "" : "error");
      loadDictionary();
    }
  };
  importWorker.postMessage({ type: "import", buffer, expectedSha256 }, [buffer]);
}

$("dictCancel").addEventListener("click", () => importWorker?.postMessage({ type: "cancel" }));
$("dictFile").addEventListener("change", async () => {
  const file = $("dictFile").files[0];
  $("dictFile").value = "";
  if (!file) return;
  if (file.size > 200e6) return say("dictMsg", "文件过大（超过 200 MB）", "error");
  runImport(await file.arrayBuffer(), null);
});
$("dictDownload").addEventListener("click", async () => {
  const opt = $("dictPackages").selectedOptions[0];
  if (!opt) return;
  say("dictMsg", "正在从服务器下载…");
  try {
    const resp = await fetch(`${env.server}/api/dict/packages/${encodeURIComponent(opt.value)}`, { credentials: "omit" });
    if (!resp.ok) throw new Error(`服务器返回 ${resp.status}`);
    runImport(await resp.arrayBuffer(), opt.dataset.sha);
  } catch (err) {
    say("dictMsg", `下载失败：${err.message}`, "error");
  }
});
$("dictRemove").addEventListener("click", async () => {
  if (!confirm("移除离线词典？生词本和复习记录不受影响，可以随时重新安装。")) return;
  await removeDictionary();
  loadDictionary();
});

// Sync

async function refreshSyncPanel() {
  const s = await env.sync.status();
  $("syncStatus").textContent = `已登录 ${s.user} @ ${hostOf(s.server || location.origin)}${s.lastAt ? ` · 上次同步 ${fmtDate.format(s.lastAt)}` : ""}`;
  if (s.lastError) say("syncMsg", `同步失败：${s.lastError}`, "error");
  refreshSyncState();
}

async function refreshSyncState() {
  const s = await env.sync.status();
  $("syncState").textContent = !s.configured ? "未登录" : s.lastError ? "同步出错" : s.lastAt ? `已同步 ${fmtDate.format(s.lastAt)}` : "等待同步";
  $("syncState").dataset.kind = s.lastError ? "error" : "";
}

$("syncNow").addEventListener("click", async () => {
  say("syncMsg", "同步中…");
  const r = await env.sync.syncNow();
  say("syncMsg", r?.ok ? `同步完成：上传 ${r.pushed}，下载 ${r.pulled}` : `同步失败：${r?.error || "未知错误"}`, r?.ok ? "ok" : "error");
  refreshSyncPanel();
});

$("syncSignOut").addEventListener("click", async () => {
  const text = env.kind === "web"
    ? "退出登录？这台设备上的网页副本会被清除（服务器上的数据保留）。"
    : "退出登录？账号数据保留在服务器和本机，下次登录同一账号即可继续；登录其他账号时本机副本会被清除。";
  if (!confirm(text)) return;
  try {
    await env.sync.signOut();
  } catch (err) {
    if (err.code !== "unsynced" || !confirm(`${err.message}\n\n仍然退出？`)) return say("syncMsg", err.message, "error");
    await env.sync.signOut({ force: true });
  }
  say("syncMsg", "");
  location.hash = "#login";
  route();
  refreshSyncState();
});

// Data

$("exportJson").addEventListener("click", async () => {
  const data = await store.exportBackup();
  downloadText(JSON.stringify(data, null, 1), backupFileName());
  say("dataMsg", `已导出 ${data.items.filter((i) => !i.deleted_at).length} 个生词、${data.sentences.filter((s) => !s.deleted_at).length} 个句子。`, "ok");
});

let pendingImport = null;
$("importJson").addEventListener("change", async () => {
  const file = $("importJson").files[0];
  $("importJson").value = "";
  if (!file) return;
  try {
    if (file.size > 50e6) throw new Error("文件过大（超过 50 MB）");
    const data = JSON.parse(await file.text());
    const summary = await store.previewBackup(data);
    pendingImport = data;
    const names = { items: "生词", encounters: "语境", cards: "卡片", events: "复习记录", sentences: "句子" };
    $("importSummary").textContent =
      `备份导出于 ${data.exported_at || "未知时间"}。将新增 ` +
      Object.entries(summary).map(([k, v]) => `${names[k]} ${v.added}`).join("、") +
      `；更新 ${Object.values(summary).reduce((n, v) => n + v.updated, 0)} 条较新的记录，其余保持不变。重复导入不会产生重复条目。`;
    $("importPreview").hidden = false;
  } catch (err) {
    say("dataMsg", `无法导入：${err.message}`, "error");
  }
});
$("importConfirm").addEventListener("click", async () => {
  if (!pendingImport) return;
  try {
    await store.importBackup(pendingImport);
    changed();
    say("dataMsg", "导入完成", "ok");
  } catch (err) {
    say("dataMsg", `导入失败：${err.message}，现有数据未改变。`, "error");
  }
  pendingImport = null;
  $("importPreview").hidden = true;
});
$("importCancel").addEventListener("click", () => {
  pendingImport = null;
  $("importPreview").hidden = true;
});

$("exportAnki").addEventListener("click", async () => {
  const rows = [];
  for (let offset = 0; offset != null; ) {
    const res = await store.listItems({ limit: 200, offset, sort: "alpha" });
    rows.push(...res.items);
    offset = res.next_offset;
  }
  downloadText(ankiTsv(rows, { cloze: $("ankiCloze").checked }), `localingo-anki-${new Date().toISOString().slice(0, 10)}.txt`, "text/plain");
  say("dataMsg", `已导出 ${rows.length} 条。在 Anki 中选择「文件 → 导入」，字段会按文件头自动对应。`, "ok");
});

// --- badges & lifecycle -------------------------------------------------------------------------------

async function refreshBadges() {
  const s = await store.reviewSummary({ dailyNew: prefs.dailyNew });
  $("navDue").hidden = !s.today_total;
  $("navDue").textContent = String(s.today_total);
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  // Words may have been saved from web pages meanwhile.
  if (!$("page-words").hidden && !$("itemDialog").open) loadWords(true);
  refreshBadges();
  if (env.kind === "web" && signedIn) {
    await env.sync.syncNow();
    refreshSyncState();
  }
});

if (isExtension) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.syncLastAt || changes.syncLastError)) refreshSyncState();
    if (area === "local" && changes.dictInstall && !$("page-lookup").hidden) loadDictionary();
    // Signed out elsewhere, or the server rejected the token.
    if (area === "local" && changes.syncToken && !changes.syncToken.newValue && signedIn) route();
  });
}

store.purgeTrash({ expiredOnly: true }).catch(() => {});
await route();
refreshBadges();
refreshSyncState();
if (env.kind === "web" && signedIn) {
  env.sync.syncNow().then(() => {
    refreshSyncState();
    route();
  });
}
