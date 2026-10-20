// Learning side panel: lookup (with a pinned card from the page) and this page's saved words.

import { createEnv } from "../learning/env.js";
import { POS_LABELS } from "../learning/dict.js";
import { cardHandlers, lookupWithSaved } from "../learning/ui/actions.js";
import { renderLookupCard } from "../learning/ui/lookup-card.js";

const env = createEnv();
const $ = (id) => document.getElementById(id);
let prefs = await env.getPrefs();
let searchController = null;
let pinController = null;
let searchSeq = 0;

// --- tabs ------------------------------------------------------------------------

const tabs = [$("tabLookup"), $("tabPage")];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (tab === $("tabPage")) refreshPage();
}
for (const t of tabs) {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const next = tabs[(tabs.indexOf(t) + 1) % tabs.length];
    next.focus();
    selectTab(next);
  });
}

// --- lookup ----------------------------------------------------------------------

async function search(query) {
  const q = query.trim();
  if (!q) return;
  $("q").value = q;
  $("lookupEmpty").hidden = true;
  const id = ++searchSeq;
  searchController?.destroy();
  let model = { query: q, busy: true, prefs };
  const controller = renderLookupCard($("searchCard"), model, {
    ...cardHandlers(env, {
      refresh: async () => {
        model = { ...model, saved: (await lookupWithSaved(env, q)).saved };
        controller.update(model);
      },
      onLookup: search,
    }),
    detail: (w) => env.openCenter(`#lookup?q=${encodeURIComponent(w)}`),
    installDictionary: () => env.openCenter("#settings"),
  });
  searchController = controller;
  const data = await lookupWithSaved(env, q);
  if (id !== searchSeq) return; // a newer search replaced this one
  model = { ...data, query: q, prefs, context: null };
  controller.update(model);
}

$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  search($("q").value);
});

async function showPin(pin) {
  pinController?.destroy();
  pinController = null;
  $("pinned").hidden = !pin?.model?.lookup;
  if (!pin?.model?.lookup) return;
  $("lookupEmpty").hidden = true;
  $("pinSource").textContent = pin.page?.title || pin.page?.url || "网页";
  $("pinSource").title = pin.page?.url || "";
  const context = pin.model.context ? { ...pin.model.context } : null;
  const q = pin.model.lookup.query;
  const model = { ...pin.model, prefs };
  pinController = renderLookupCard($("pinCard"), model, {
    ...cardHandlers(env, {
      context,
      refresh: async () => pinController?.update({ ...model, saved: (await lookupWithSaved(env, q)).saved }),
      onLookup: search,
    }),
    detail: (w) => env.openCenter(`#lookup?q=${encodeURIComponent(w)}`),
  });
  // Saved state may have changed since the card was pinned.
  pinController.update({ ...model, saved: (await lookupWithSaved(env, q)).saved });
}

$("unpin").addEventListener("click", async () => {
  await chrome.storage.session.remove("ll:pin:last");
  showPin(null);
});

// --- this page ---------------------------------------------------------------------

async function currentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: "learning:page-info" });
    return info?.url ? info : null;
  } catch {
    return null;
  }
}

async function refreshPage() {
  if ($("panePage").hidden) return;
  const page = await currentPage();
  $("pageTitle").textContent = page ? page.title || page.url : "无法读取此页面（浏览器内部页面或尚未加载）";
  const items = page ? await env.store.itemsForPage(page.url) : [];
  $("pageItems").replaceChildren(
    ...items.map((i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "item-row";
      const head = document.createElement("strong");
      head.textContent = i.headword;
      const gloss = document.createElement("span");
      gloss.textContent = `${i.pos ? (POS_LABELS[i.pos] || i.pos) + " " : ""}${i.user_gloss || i.meaning?.gloss_zh || i.meaning?.definition_en || ""}`;
      b.append(head, gloss);
      b.addEventListener("click", () => env.openCenter(`#item=${encodeURIComponent(i.id)}`));
      li.append(b);
      return li;
    }),
  );
  $("pageEmpty").hidden = !!items.length || !page;
}

chrome.tabs.onActivated.addListener(() => refreshPage());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === "complete") refreshPage();
});

// --- header / footer -----------------------------------------------------------------

async function refreshDue() {
  const s = await env.store.reviewSummary({ dailyNew: prefs.dailyNew });
  $("dueCount").textContent = String(s.today_total);
}

$("reviewLink").addEventListener("click", () => env.openCenter("#review"));
$("openCenter").addEventListener("click", () => env.openCenter(""));

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes["ll:pin:last"]) showPin(changes["ll:pin:last"].newValue);
});
chrome.storage.sync.onChanged.addListener(async (changes) => {
  if (changes.learnPrefs) prefs = await env.getPrefs();
});
env.store.onChange(() => {
  refreshDue();
  refreshPage();
});

const { "ll:pin:last": pin } = await chrome.storage.session.get("ll:pin:last");
showPin(pin);
refreshDue();
setInterval(refreshDue, 60_000);
