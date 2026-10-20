// Injected by the fixture server, never shipped with the actual popup.
(() => {
  window.addEventListener("error", (event) => {
    const diagnostic = document.createElement("pre");
    diagnostic.hidden = true;
    diagnostic.dataset.fixtureError = "true";
    diagnostic.textContent = `${event.message}\n${event.filename}:${event.lineno}\n${event.error?.stack || ""}`;
    document.body?.appendChild(diagnostic);
  });
  const fixture = window.top.fixture;
  const storageArea = (area) => ({
    async get(query) {
      if (typeof query === "string") return { [query]: fixture[area][query] };
      return { ...query, ...fixture[area] };
    },
    async set(values) {
      const changes = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          { oldValue: fixture[area][key], newValue: value },
        ]),
      );
      Object.assign(fixture[area], values);
      fixture.listeners.forEach((listener) => listener(changes, area));
    },
    async remove(keys) {
      for (const key of [].concat(keys)) delete fixture[area][key];
    },
  });
  fixture.session ||= {};
  const send = (message) =>
    new Promise((resolve, reject) => {
      if (!fixture.pageHandlers.length)
        return reject(new Error("No content script"));
      for (const handler of fixture.pageHandlers) handler(message, {}, resolve);
    });
  window.chrome = {
    storage: {
      sync: storageArea("sync"),
      local: storageArea("local"),
      session: storageArea("session"),
      onChanged: {
        addListener: (listener) => fixture.listeners.push(listener),
      },
    },
    runtime: {
      onMessage: {
        addListener: (listener) => fixture.pageHandlers.push(listener),
      },
      async sendMessage(message) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (fixture.failNext) {
          fixture.failNext = false;
          return { ok: false, error: "Fixture: temporary service failure" };
        }
        return {
          ok: true,
          translations: message.texts.map((text) =>
            text.startsWith("Designing")
              ? "设计一个更安静的网络"
              : text.startsWith("This sentence")
                ? "阅读时这句话发生了变化，译文也应该随之更新。"
                : text.startsWith("New paragraphs")
                  ? "新段落自然出现，无需重新启动页面翻译。"
                  : "好的工具让我们专注阅读，理解文字背后的意思。保留原文，也让新的理解自然发生。",
          ),
        };
      },
    },
    tabs: {
      async query() {
        return [
          {
            id: 1,
            title: "Designing a quieter web",
            url:
              fixture.scenario === "blocked"
                ? "chrome://extensions/"
                : "https://read.localingo.test/article",
          },
        ];
      },
      sendMessage: (_, message) => send(message),
    },
    scripting: {
      async insertCSS() {},
      async executeScript() {
        throw new Error("Article fixture must load first");
      },
    },
    commands: {
      async getAll() {
        return [{ name: "toggle-mode", shortcut: "Alt+T" }];
      },
    },
  };
  if (location.pathname.endsWith("popup.html")) {
    window.fetch = async () => {
      if (!fixture.connected) throw new Error("Fixture: offline");
      return {
        ok: true,
        async json() {
          return fixture.scenario === "legacy"
            ? { loaded: true, model: "fixture/legacy-model" }
            : {
                authorized: Boolean(fixture.local.authToken),
                loaded: true,
                model: "fixture/local-model",
              };
        },
      };
    };
  }
})();
