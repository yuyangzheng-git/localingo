import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(
  new URL("../extension/popup.js", import.meta.url),
  "utf8",
);

// The controller's Chrome/DOM boundary is mocked; full DOM behavior is exercised
// by tests/browser/preview.html using the real popup and content script.
async function harness({
  supported = true,
  online = true,
  legacy = false,
  active = false,
} = {}) {
  const elements = new Map();
  const saved = [];
  const element = (id) => {
    if (elements.has(id)) return elements.get(id);
    const el = {
      id,
      dataset: {},
      textContent: "",
      value: "",
      type: "password",
      disabled: false,
      hidden: false,
      listeners: {},
      attributes: {},
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      removeAttribute(key) {
        delete this.attributes[key];
      },
      querySelectorAll() {
        return this.options || [];
      },
      focus() {},
    };
    elements.set(id, el);
    return el;
  };
  for (const [id, values] of [
    ["displayMode", ["bilingual", "translation"]],
    ["translationStyle", ["plain", "muted", "underline"]],
  ]) {
    element(id).options = values.map((value) =>
      Object.assign(element(`${id}:${value}`), { dataset: { value } }),
    );
  }
  const context = vm.createContext({
    document: { getElementById: element },
    window: { addEventListener() {}, close() {} },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    navigator: { clipboard: { async writeText() {} } },
    fetch: async () => {
      if (!online) throw new Error("Offline");
      return {
        ok: true,
        async json() {
          // Token-era services answer authorized: false without a token.
          return legacy ? { authorized: false, loaded: true } : { authorized: true, loaded: true };
        },
      };
    },
    chrome: {
      storage: {
        sync: {
          async get(defaults) {
            return { ...defaults };
          },
          async set(values) {
            saved.push(values);
          },
        },
        local: {
          async get() {
            return {};
          },
          async set(values) {
            saved.push(values);
          },
        },
      },
      tabs: {
        async create(opts) {
          saved.push({ opened: opts.url });
        },
        async query() {
          return [
            {
              id: 7,
              title: "Current article",
              url: supported
                ? "https://example.test/article"
                : "chrome://settings/",
            },
          ];
        },
        async sendMessage() {
          return {
            ok: true,
            active,
            processing: false,
            waiting: 2,
            stats: { translated: 4, cached: 3, failed: 0 },
          };
        },
      },
      commands: {
        async getAll() {
          return [{ name: "toggle-mode", shortcut: "Alt+T" }];
        },
      },
    },
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { context, element, saved };
}

test("current page stats, not another tab’s last result, drive the popup", async () => {
  const { element } = await harness({ active: true });
  assert.equal(element("pageTitle").textContent, "Current article");
  assert.equal(element("translatedCount").textContent, 4);
  assert.equal(element("cachedCount").textContent, 3);
  assert.equal(element("toggleLabel").textContent, "恢复原文");
});

test("an offline server blocks new translation but does not block restoring originals", async () => {
  const idle = await harness({ online: false });
  assert.equal(idle.element("toggle").disabled, true);
  const active = await harness({ online: false, active: true });
  assert.equal(active.element("toggle").disabled, false);
  assert.equal(active.element("toggleLabel").textContent, "恢复原文");
});

test("unsupported pages remain disabled even when the server is connected", async () => {
  const { element } = await harness({ supported: false });
  assert.equal(element("toggle").disabled, true);
  assert.match(element("notice").textContent, /普通网页/);
});

test("token-era services are told to update; no token is ever asked for", async () => {
  const old = await harness({ legacy: true });
  assert.equal(old.element("statusText").textContent, "服务需更新");
  assert.match(old.element("notice").textContent, /旧版本/);
  assert.equal(old.element("setup").hidden, false);
  const ok = await harness();
  assert.equal(ok.element("statusText").textContent, "本地已连接");
  assert.equal(ok.element("setup").hidden, true);
});

test("an offline service points to the one-click installer", async () => {
  const { element, saved } = await harness({ online: false });
  assert.equal(element("statusText").textContent, "服务未运行");
  assert.match(element("notice").textContent, /一键安装/);
  assert.equal(element("setup").hidden, false);
  element("installLink").listeners.click();
  assert.deepEqual(saved.at(-1), { opened: "http://101.35.6.63:8083/#install" });
});

test("translation-only mode disables the entire style fieldset for keyboard users", async () => {
  const { context, element } = await harness();
  context.renderDisplayMode("translation");
  assert.equal(element("styleGroup").disabled, true);
  context.renderDisplayMode("bilingual");
  assert.equal(element("styleGroup").disabled, false);
});

test("late connection responses cannot overwrite the newest health result", async () => {
  const { context, element } = await harness();
  const pending = [];
  context.fetch = () => new Promise((resolve) => pending.push(resolve));
  const first = context.checkHealth();
  await new Promise((resolve) => setImmediate(resolve));
  const second = context.checkHealth();
  await new Promise((resolve) => setImmediate(resolve));
  pending[1]({
    ok: true,
    async json() {
      return { authorized: true };
    },
  });
  await second;
  pending[0]({
    ok: true,
    async json() {
      return { authorized: false };
    },
  });
  await first;
  assert.equal(element("statusText").textContent, "本地已连接");
  assert.equal(element("toggle").disabled, false);
});
