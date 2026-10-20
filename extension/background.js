// Service worker (ES module): selection translation via the local MLX server, and the
// learning features — offline dictionary lookup, vocabulary book, speech, side panel
// and sync — which work without the translation server.

import { lookup } from "./learning/dict.js";
import { IdbDictionary } from "./learning/dict-idb.js";
import { DEFAULT_PREFS, normalizePrefs } from "./learning/prefs.js";
import { LearningStore, ValidationError } from "./learning/store.js";
import { ApiClient, syncOnce } from "./learning/sync.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
const MAX_MESSAGE_CHARS = 40_000;
const SYNC_ALARM = "localingo-sync";
const SYNC_DEBOUNCE_MS = 5000;

const dictionary = new IdbDictionary();
const store = new LearningStore();

// --- translation (local MLX server) ---------------------------------------------

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL });
  return (serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

// The token is printed by `uv run web-translator` and pasted into the popup.
// Kept in storage.local (not sync) so it stays on this machine.
async function getAuthToken() {
  const { authToken } = await chrome.storage.local.get({ authToken: "" });
  return authToken;
}

async function translateTexts(texts) {
  const token = await getAuthToken();
  if (!token) {
    throw new Error("no auth token — paste the server's token into the extension popup");
  }
  const resp = await fetch(`${await getServerUrl()}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": token,
    },
    body: JSON.stringify({ texts }),
  });
  if (resp.status === 401) {
    throw new Error("auth token rejected — copy the current token from the server into the popup");
  }
  if (!resp.ok) {
    throw new Error(`server error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.translations;
}

async function checkHealth() {
  try {
    const resp = await fetch(`${await getServerUrl()}/health`, {
      headers: { "X-Auth-Token": await getAuthToken() },
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

// --- learning ---------------------------------------------------------------------

async function getPrefs() {
  const { learnPrefs } = await chrome.storage.sync.get({ learnPrefs: DEFAULT_PREFS });
  return normalizePrefs(learnPrefs);
}

async function handleLookup({ query }) {
  if (typeof query !== "string" || !query.trim()) throw new ValidationError("没有要查询的内容");
  const result = await lookup(query, dictionary);
  const keys = [...new Set(result.results.map((r) => r.entry.k))];
  const saved = keys.length ? await store.itemsForLexemes(keys) : [];
  const info = await dictionary.info();
  return { lookup: result, saved, prefs: await getPrefs(), dictionary_version: info?.source_version || null };
}

async function handleUndo({ item_id, encounter_id, result }) {
  if (result === "created" && typeof item_id === "string") {
    await store.deleteItem(item_id);
    await store.purgeTrash({ ids: [item_id] });
  } else if (result === "updated" && typeof encounter_id === "string") {
    await store.deleteEncounter(encounter_id);
  }
  scheduleSync();
  return { ok: true };
}

// Speech: only voices Chrome reports as local (remote === false) unless the user
// explicitly allowed online voices.
async function englishVoices() {
  const prefs = await getPrefs();
  const voices = await chrome.tts.getVoices();
  return voices
    .filter((v) => (v.lang || "").toLowerCase().startsWith("en"))
    .filter((v) => v.remote === false || (prefs.allowRemoteVoices && v.remote === true))
    .map((v) => ({ name: v.voiceName, lang: v.lang, remote: !!v.remote }));
}

async function speak({ text, rate }) {
  if (typeof text !== "string" || !text.trim() || text.length > 1200) throw new ValidationError("没有可朗读的文字");
  const prefs = await getPrefs();
  const voices = await englishVoices();
  if (!voices.length) {
    return { ok: false, error: "没有可用的本地英语声音。可在系统设置 → 辅助功能 → 朗读内容中安装英语声音。" };
  }
  const voice = voices.find((v) => v.name === prefs.voiceName) || voices.find((v) => !v.remote) || voices[0];
  chrome.tts.stop();
  chrome.tts.speak(text, { voiceName: voice.name, lang: voice.lang, rate: Number(rate) || prefs.speechRate, enqueue: false });
  return { ok: true, voice: voice.name };
}

async function openSidePanel(tabId, windowId) {
  try {
    if (tabId != null) await chrome.sidePanel.open({ tabId });
    else await chrome.sidePanel.open({ windowId });
    return { ok: true };
  } catch {
    // Older Chrome or no user gesture: fall back to the learning center tab.
    await chrome.tabs.create({ url: chrome.runtime.getURL("learn.html#lookup") });
    return { ok: true, fallback: "tab" };
  }
}

// --- sync -------------------------------------------------------------------------

let syncTimer = null;
let syncRunning = null;

async function syncSettings() {
  return chrome.storage.local.get({ syncServer: "", syncToken: "", syncUser: "" });
}

async function syncNow() {
  if (syncRunning) return syncRunning;
  syncRunning = (async () => {
    const { syncServer, syncToken } = await syncSettings();
    if (!syncServer || !syncToken) return { ok: false, skipped: true };
    const origin = new URL(syncServer).origin + "/*";
    if (!(await chrome.permissions.contains({ origins: [origin] }))) {
      await chrome.storage.local.set({ syncLastError: "需要重新授权访问同步服务器" });
      return { ok: false, error: "需要重新授权访问同步服务器" };
    }
    try {
      const result = await syncOnce(store, new ApiClient({ baseUrl: syncServer, token: syncToken }));
      await chrome.storage.local.set({ syncLastAt: Date.now(), syncLastError: "" });
      return { ok: true, ...result };
    } catch (err) {
      await chrome.storage.local.set({ syncLastError: err?.message || String(err) });
      if (err?.status === 401) await chrome.storage.local.set({ syncToken: "" });
      return { ok: false, error: err?.message || String(err) };
    }
  })();
  try {
    return await syncRunning;
  } finally {
    syncRunning = null;
  }
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow().catch(() => {}), SYNC_DEBOUNCE_MS);
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow().catch(() => {});
});

// --- setup ------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "translate-selection", title: "翻译成中文", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "lookup-selection", title: "在 LocaLingo 中查词", contexts: ["selection"] });
  });
  if (reason === "install") {
    // New users start in 学习阅读; upgrades keep their existing reading mode.
    const { displayMode } = await chrome.storage.sync.get("displayMode");
    if (!displayMode) await chrome.storage.sync.set({ displayMode: "learn" });
  }
  chrome.alarms?.create(SYNC_ALARM, { periodInMinutes: 30 });
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms?.create(SYNC_ALARM, { periodInMinutes: 30 });
  syncNow().catch(() => {});
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.selectionText || !tab?.id) return;
  const text = info.selectionText.trim();
  if (!text) return;

  if (info.menuItemId === "lookup-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "learning:show-lookup", text }).catch(() => {});
    return;
  }
  if (info.menuItemId !== "translate-selection") return;

  const show = async (state) => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "show-result", original: text, ...state });
      return true;
    } catch {
      return false; // Content script not available (e.g. chrome:// page).
    }
  };

  if (!(await show({ loading: true }))) return;
  try {
    const [translation] = await translateTexts([text]);
    await show({ translation });
  } catch (err) {
    await show({ error: err && err.message ? err.message : String(err) });
  }
});

// --- messages -----------------------------------------------------------------------

const LEARNING_HANDLERS = {
  "learning:lookup": (m) => handleLookup(m),
  "learning:save": async (m) => {
    const r = await store.saveItem(m.payload || {});
    scheduleSync();
    return r;
  },
  "learning:undo": (m) => handleUndo(m),
  "learning:save-sentence": async (m) => {
    const r = await store.saveSentence(m.payload || {});
    scheduleSync();
    return r;
  },
  "learning:speak": (m) => speak(m),
  "learning:stop-speech": async () => {
    chrome.tts.stop();
    return { ok: true };
  },
  "learning:voices": async () => ({ voices: await englishVoices() }),
  "learning:summary": async () => {
    const prefs = await getPrefs();
    return { summary: await store.reviewSummary({ dailyNew: prefs.dailyNew }), dictionary: await dictionary.info().then((m) => (m ? { package_id: m.package_id, entries: m.entries } : null)) };
  },
  "learning:page-items": async (m) => ({ items: await store.itemsForPage(String(m.url || "")) }),
  "learning:sync-now": () => syncNow(),
  "learning:changed": async () => {
    scheduleSync();
    return { ok: true };
  },
};

function senderAllowed(sender) {
  return sender.id === chrome.runtime.id;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!senderAllowed(sender) || !message || typeof message.type !== "string") return false;

  if (message.type === "translate-texts") {
    translateTexts(message.texts)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true; // keep the channel open for async sendResponse
  }
  if (message.type === "health") {
    checkHealth().then((data) => sendResponse({ ok: true, data }));
    return true;
  }
  if (message.type === "learning:open-panel") {
    // Must run synchronously inside the user gesture that sent the message.
    openSidePanel(sender.tab?.id ?? message.tabId, message.windowId).then(sendResponse);
    return true;
  }
  if (message.type === "learning:pin") {
    const tabId = sender.tab?.id ?? message.tabId;
    const pin = { model: message.model, page: { url: sender.tab?.url || "", title: sender.tab?.title || "" }, pinned_at: Date.now() };
    const opened = openSidePanel(tabId, message.windowId);
    chrome.storage.session.set({ [`ll:pin:${tabId}`]: pin, "ll:pin:last": { ...pin, tabId } }).catch(() => {});
    opened.then(sendResponse);
    return true;
  }
  if (message.type === "learning:open-center") {
    const hash = typeof message.hash === "string" ? message.hash.slice(0, 200) : "";
    chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") + hash }).then(() => sendResponse({ ok: true }));
    return true;
  }

  const handler = LEARNING_HANDLERS[message.type];
  if (!handler) return false;
  if (JSON.stringify(message).length > MAX_MESSAGE_CHARS) {
    sendResponse({ ok: false, error: "请求内容过长" });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message))
    .then((data) => sendResponse({ ok: true, request_id: message.request_id, ...data }))
    .catch((err) =>
      sendResponse({
        ok: false,
        request_id: message.request_id,
        error: err instanceof ValidationError ? err.message : err?.message || String(err),
      }),
    );
  return true;
});

// Keyboard shortcuts: toggle translation, look up the current selection.
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  const type = command === "toggle-mode" ? "web-translator:toggle" : command === "lookup-selection" ? "learning:show-lookup" : null;
  if (!type) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    // content script not available on this tab — nothing to do
  }
});
