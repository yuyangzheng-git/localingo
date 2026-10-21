// In-page stand-in for the Chrome extension APIs used by background.js, content.js
// and content-learn.js, so the real scripts can run together on one test page
// (see learn-harness.html). Messages are delivered in-process; storage is in memory;
// the local translation server is faked.
(() => {
  const listeners = { message: [], installed: [], startup: [], menu: [], command: [], alarm: [], storage: [] };
  const record = (window.__chromeLog = { opened: [], spoken: [], sidePanel: [], tabMessages: [] });

  function area(name) {
    const data = {};
    const changed = new Set();
    const fire = (changes) => {
      for (const fn of listeners.storage) fn(changes, name);
      for (const fn of changed) fn(changes);
    };
    return {
      _data: data,
      async get(keys) {
        if (keys == null) return structuredClone(data);
        if (typeof keys === "string") return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
        if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
        return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        fire(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const k of [].concat(keys)) {
          changes[k] = { oldValue: data[k] };
          delete data[k];
        }
        fire(changes);
      },
      onChanged: { addListener: (fn) => changed.add(fn) },
    };
  }

  const tab = () => ({ id: 1, windowId: 1, url: location.href, title: document.title });

  function deliver(msg, sender) {
    return new Promise((resolve) => {
      let async = false;
      let done = false;
      const sendResponse = (r) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      for (const fn of listeners.message) {
        if (fn(structuredClone(msg), sender, sendResponse) === true) async = true;
      }
      if (!async && !done) resolve(undefined);
    });
  }

  window.chrome = {
    runtime: {
      id: "harness",
      getURL: (p) => "/extension/" + String(p).replace(/^\//, ""),
      sendMessage: (msg) => deliver(msg, { id: "harness", tab: tab(), url: location.href }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    },
    storage: {
      sync: area("sync"),
      local: area("local"),
      session: area("session"),
      onChanged: { addListener: (fn) => listeners.storage.push(fn) },
    },
    tabs: {
      async query() {
        return [tab()];
      },
      async create(opts) {
        record.opened.push(opts.url);
        return { id: 2 };
      },
      async sendMessage(_tabId, msg) {
        record.tabMessages.push(msg.type);
        return deliver(msg, { id: "harness" });
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    tts: {
      async getVoices() {
        return window.__voices ?? [{ voiceName: "Samantha", lang: "en-US", remote: false }, { voiceName: "Cloud Voice", lang: "en-GB", remote: true }];
      },
      speak(text, opts) {
        record.spoken.push({ text, voice: opts.voiceName, rate: opts.rate });
      },
      stop() {},
    },
    sidePanel: {
      async open(opts) {
        record.sidePanel.push(opts);
      },
      async setPanelBehavior() {},
    },
    contextMenus: { create() {}, removeAll(cb) { cb?.(); }, onClicked: { addListener: (fn) => listeners.menu.push(fn) } },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) }, async getAll() { return []; } },
    alarms: { create() {}, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
    permissions: { async contains() { return true; }, async request() { return true; } },
  };

  // Fake local MLX translation server.
  const realFetch = window.fetch.bind(window);
  window.__translateCalls = [];
  window.fetch = async (url, opts) => {
    if (String(url).startsWith("http://127.0.0.1:8765/translate")) {
      const { texts } = JSON.parse(opts.body);
      window.__translateCalls.push(texts);
      await new Promise((r) => setTimeout(r, 60));
      return new Response(JSON.stringify({ translations: texts.map((t) => `【译】${t.slice(0, 40)}`) }), { status: 200 });
    }
    // Fake LocaLingo account server: any password of 10+ characters signs in.
    if (String(url).startsWith("http://101.35.6.63:8083/api/")) {
      const path = new URL(url).pathname;
      const body = opts?.body ? JSON.parse(opts.body) : {};
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/health") return json({ ok: true, signup: true, dictionary: true });
      if (path === "/api/auth/login" || path === "/api/auth/signup") {
        if ((body.password || "").length < 10) return json({ detail: "用户名或密码错误" }, 401);
        return json({ token: `harness-sync-${body.username}`, user: { username: body.username } });
      }
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      if (path === "/api/sync/push") return json({ accepted: 0 });
      if (path === "/api/sync/pull") return json({ changes: {}, cursor: 0, more: false });
      if (path === "/api/dict/info") return json({ packages: [] });
      return json({ detail: "not found" }, 404);
    }
    return realFetch(url, opts);
  };
  // Start signed in to a LocaLingo account (saving words needs one); ?signedout doesn't.
  if (!new URLSearchParams(location.search).has("signedout")) chrome.storage.local.set({ syncToken: "harness-sync-tester", syncUser: "tester", syncOwner: "tester" });
})();
