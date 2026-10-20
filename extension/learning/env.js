// Platform services for the learning pages (side panel, learning center). The same
// pages run as extension pages (local data, offline dictionary, background sync) or
// as the hosted web app served by the LocaLingo server (synced copy, server-side
// dictionary, browser speech).

import { RemoteDictionary } from "./dict.js";
import { IdbDictionary } from "./dict-idb.js";
import { DEFAULT_PREFS, normalizePrefs } from "./prefs.js";
import { LearningStore } from "./store.js";
import { ApiClient, login, syncOnce } from "./sync.js";

export const isExtension =
  typeof chrome !== "undefined" &&
  !!chrome.runtime?.id &&
  (location.protocol === "chrome-extension:" || globalThis.__localingoTestExtension === true); // test harness only

export function createEnv() {
  return isExtension ? extensionEnv() : webEnv();
}

/** Validate a sync server address: https, or http only for localhost development. */
export function syncServerOrigin(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("请输入完整地址，例如 https://learn.example.com");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("同步服务器必须使用 https://（本机调试可用 http://localhost）");
  if (url.username || url.password || url.search || url.hash) throw new Error("地址中不能包含账号、参数或 #");
  return url.origin;
}

function extensionEnv() {
  const store = new LearningStore();
  const send = async (message) => {
    const resp = await chrome.runtime.sendMessage(message);
    if (!resp) throw new Error("扩展后台没有响应");
    return resp;
  };
  return {
    kind: "extension",
    store,
    dictionary: new IdbDictionary(),
    async getPrefs() {
      const { learnPrefs } = await chrome.storage.sync.get({ learnPrefs: DEFAULT_PREFS });
      return normalizePrefs(learnPrefs);
    },
    async setPrefs(patch) {
      const next = normalizePrefs({ ...(await this.getPrefs()), ...patch });
      await chrome.storage.sync.set({ learnPrefs: next });
      return next;
    },
    async speak(text, rate) {
      return send({ type: "learning:speak", text, rate });
    },
    async voices() {
      return (await send({ type: "learning:voices" })).voices || [];
    },
    notifyChange() {
      send({ type: "learning:changed" }).catch(() => {});
    },
    openCenter(hash = "") {
      chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") + hash });
    },
    sync: {
      async status() {
        const s = await chrome.storage.local.get({ syncServer: "", syncToken: "", syncUser: "", syncLastAt: 0, syncLastError: "" });
        return { configured: !!(s.syncServer && s.syncToken), server: s.syncServer, user: s.syncUser, lastAt: s.syncLastAt, lastError: s.syncLastError, needsLogin: !!s.syncServer && !s.syncToken };
      },
      /** Must be called from a click handler: asks Chrome for access to the server first. */
      async signIn(server, username, password) {
        const origin = syncServerOrigin(server);
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) throw new Error("需要允许访问该服务器才能同步");
        const { token, user } = await login(origin, username, password, { deviceLabel: "Chrome 扩展" });
        await chrome.storage.local.set({ syncServer: origin, syncToken: token, syncUser: user.username, syncLastError: "" });
        return send({ type: "learning:sync-now" });
      },
      async syncNow() {
        return send({ type: "learning:sync-now" });
      },
      async signOut() {
        const s = await chrome.storage.local.get({ syncServer: "", syncToken: "" });
        if (s.syncServer && s.syncToken) {
          await new ApiClient({ baseUrl: s.syncServer, token: s.syncToken }).post("/api/auth/logout").catch(() => {});
        }
        // Local data stays: the extension copy is authoritative.
        await chrome.storage.local.set({ syncToken: "", syncUser: "", syncLastError: "" });
        await chrome.storage.local.remove("syncServer");
      },
    },
  };
}

function webEnv() {
  const TOKEN_KEY = "localingo:token";
  const USER_KEY = "localingo:user";
  const PREFS_KEY = "localingo:prefs";
  const store = new LearningStore({ dbName: "localingo-learn-web" });
  const api = new ApiClient({ baseUrl: "", token: localStorage.getItem(TOKEN_KEY) || "" });
  let syncTimer = null;
  let lastError = "";
  let lastAt = Number(localStorage.getItem("localingo:lastSync") || 0);
  const run = async () => {
    try {
      const r = await syncOnce(store, api);
      lastError = "";
      lastAt = Date.now();
      localStorage.setItem("localingo:lastSync", String(lastAt));
      env.onSynced?.();
      return { ok: true, ...r };
    } catch (err) {
      lastError = err?.message || String(err);
      env.onSynced?.();
      if (err?.status === 401) env.signedOut?.();
      return { ok: false, error: lastError };
    }
  };
  async function adopt(token, username) {
    // Never mix two accounts' data in one browser copy.
    if (localStorage.getItem(USER_KEY) && localStorage.getItem(USER_KEY) !== username) await store.destroy();
    api.token = token;
    env.user = username;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, username);
    return run();
  }
  const env = {
    kind: "web",
    store,
    api,
    dictionary: new RemoteDictionary(api),
    user: localStorage.getItem(USER_KEY) || "",
    get signedIn() {
      return !!api.token;
    },
    async getPrefs() {
      try {
        return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"));
      } catch {
        return normalizePrefs({});
      }
    },
    async setPrefs(patch) {
      const next = normalizePrefs({ ...(await this.getPrefs()), ...patch });
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    },
    async voices() {
      const prefs = await this.getPrefs();
      const list = await new Promise((resolve) => {
        const v = speechSynthesis.getVoices();
        if (v.length) return resolve(v);
        speechSynthesis.addEventListener("voiceschanged", () => resolve(speechSynthesis.getVoices()), { once: true });
        setTimeout(() => resolve(speechSynthesis.getVoices()), 800);
      });
      return list
        .filter((v) => v.lang.toLowerCase().startsWith("en") && (v.localService || prefs.allowRemoteVoices))
        .map((v) => ({ name: v.name, lang: v.lang, remote: !v.localService }));
    },
    async speak(text, rate) {
      if (typeof speechSynthesis === "undefined") return { ok: false, error: "此浏览器不支持朗读" };
      const prefs = await this.getPrefs();
      const voices = await this.voices();
      if (!voices.length) return { ok: false, error: "没有可用的本地英语声音" };
      const all = speechSynthesis.getVoices();
      const chosen = all.find((v) => v.name === prefs.voiceName && voices.some((x) => x.name === v.name)) || all.find((v) => v.name === voices[0].name);
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = chosen;
      u.lang = chosen.lang;
      u.rate = Number(rate) || prefs.speechRate;
      speechSynthesis.speak(u);
      return { ok: true };
    },
    notifyChange() {
      if (!api.token) return; // local mode: no server to sync with
      clearTimeout(syncTimer);
      syncTimer = setTimeout(run, 3000);
    },
    sync: {
      async status() {
        return { configured: !!api.token, server: location.origin, user: env.user, lastAt, lastError, needsLogin: !api.token };
      },
      async signIn(_server, username, password) {
        const { token, user } = await login("", username, password, { deviceLabel: "网页" });
        return adopt(token, user.username);
      },
      async signUp(username, password) {
        const data = await api.post("/api/auth/signup", { username, password, device_label: "网页" });
        return adopt(data.token, data.user.username);
      },
      syncNow: run,
      async signOut({ force = false } = {}) {
        await run().catch(() => {});
        const unsynced = await store.dirtyRecords(1);
        if (!force && Object.keys(unsynced).length) {
          const err = new Error("还有更改没有同步到服务器。请联网同步后再退出，或选择仍然退出（会丢弃这些更改）。");
          err.code = "unsynced";
          throw err;
        }
        await api.post("/api/auth/logout").catch(() => {});
        api.token = "";
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        env.user = "";
        await store.destroy(); // the server keeps the data; this browser's copy goes
      },
    },
  };
  return env;
}
