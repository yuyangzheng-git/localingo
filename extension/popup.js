// The local translation service set up by the one-click installer (no token: it only
// answers Chrome extensions).
const TRANSLATOR_URL = "http://127.0.0.1:8765";
const INSTALL_PAGE = "http://101.35.6.63:8083/#install";
const DEFAULT_SETTINGS = {
  displayMode: "bilingual",
  translationStyle: "plain",
};
const STYLES = ["plain", "muted", "underline"];
const MODES = ["learn", "bilingual", "translation"];
const $ = (id) => document.getElementById(id);
const state = {
  tab: null,
  supported: false,
  active: false,
  busy: false,
  connected: false,
  checking: true,
  commandPending: false,
  mode: "bilingual",
};
let connectionNotice = "";
let connectionKind = "error";
let healthRequest = 0;
let healthController;
let pageRequestPending = false;

function setNotice(text, kind = "error") {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
  $("notice").dataset.kind = kind;
}

function renderNotice() {
  setNotice(
    state.supported
      ? connectionNotice
      : "浏览器内部页面、应用商店和 PDF 暂不支持翻译，请打开普通网页。",
    state.supported ? connectionKind : "info",
  );
}

function renderAction() {
  const learn = state.mode === "learn";
  // 学习阅读 can start without the translation server: it only translates the
  // paragraphs the reader reveals, and offline lookup works regardless.
  $("toggle").disabled =
    state.commandPending ||
    !state.supported ||
    (!state.active && !learn && (!state.connected || state.checking));
  $("toggle").dataset.active = String(state.active);
  $("toggleLabel").textContent = !state.supported
    ? "此页面暂不支持"
    : state.commandPending
      ? "正在处理…"
      : state.active
        ? state.busy
          ? "停止并恢复原文"
          : learn
            ? "关闭学习阅读"
            : "恢复原文"
        : learn
          ? "开始学习阅读"
          : state.checking
          ? "正在检查连接…"
          : !state.connected
            ? "本地翻译服务未运行"
            : "翻译此页";
  $("toggleIcon").textContent = state.active ? "↶" : "↗";
  $("actionHint").textContent = learn
    ? state.connected
      ? "只翻译你点开的段落；查词和复习完全离线。"
      : "查词可离线使用；看段落译文需要本地翻译服务。"
    : state.active
      ? "可随时关闭弹窗，翻译会在当前页面继续。"
      : "优先翻译可见段落，继续滚动即可接着翻译。";
  $("retryFailed").disabled =
    state.busy || !state.connected || state.commandPending;
}

function renderPage(data) {
  state.active = Boolean(data?.active);
  state.busy = Boolean(data?.processing);
  const stats = { translated: 0, cached: 0, failed: 0, ...data?.stats };
  for (const key of ["translated", "cached", "failed"])
    $(key + "Count").textContent = stats[key];
  $("metrics").hidden = !state.active;
  $("activity").hidden = !state.busy;
  $("pageDot").dataset.state = state.busy
    ? "busy"
    : stats.failed
      ? "error"
      : state.active
        ? "active"
        : "idle";
  $("pageState").textContent = !state.supported
    ? "此页面无法注入翻译内容"
    : state.busy
      ? `正在翻译 · ${(data.queued || 0) + (data.inFlight || 0)} 段处理中`
      : stats.failed
        ? `${stats.failed} 段未完成，可以单独重试`
        : state.active && state.mode === "learn"
          ? `学习阅读 · 已显示 ${stats.translated + stats.cached} 段译文`
          : state.active
          ? data.waiting
            ? "当前内容已处理，滚动以翻译更多"
            : stats.translated + stats.cached
              ? "当前内容已处理，也会跟随页面更新"
              : "没有找到可翻译的英文正文"
          : "原文阅读 · 尚未开启翻译";
  $("pageError").hidden = !stats.failed;
  $("pageErrorText").textContent = stats.failed
    ? "部分段落翻译失败。检查服务连接后，可保留已完成内容并重试。"
    : "";
  renderAction();
}

async function sendToTab(message) {
  if (state.tab?.id == null) throw new Error("找不到当前页面");
  return chrome.tabs.sendMessage(state.tab.id, message);
}

async function refreshPageState() {
  if (!state.supported || pageRequestPending || state.commandPending) return;
  pageRequestPending = true;
  try {
    const response = await sendToTab({ type: "web-translator:stats" });
    if (!response?.ok) throw new Error("页面未响应");
    renderPage(response);
  } catch {
    state.supported = false;
    renderPage(null);
    renderNotice();
  } finally {
    pageRequestPending = false;
  }
}

async function checkHealth() {
  const request = ++healthRequest;
  healthController?.abort();
  const controller = new AbortController();
  healthController = controller;
  const timeout = setTimeout(() => controller.abort(), 5000);
  state.checking = true;
  $("status").dataset.state = "checking";
  $("statusText").textContent = "连接中";
  renderAction();
  try {
    const response = await fetch(`${TRANSLATOR_URL}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (request !== healthRequest) return;
    // Token-era services answer authorized: false (or omit it) without a token.
    if (data.authorized !== true) {
      const error = new Error("服务版本不兼容");
      error.name = "ServerVersionError";
      throw error;
    }
    state.connected = true;
    $("status").dataset.state = "ok";
    $("statusText").textContent = "本地已连接";
    $("status").title = `模型：${data.model || "本地模型"}${data.loaded ? "（已加载）" : "（首次翻译时加载）"}。点击重新检查。`;
    connectionNotice = "";
    $("setup").hidden = true;
  } catch (error) {
    if (request !== healthRequest) return;
    state.connected = false;
    $("status").dataset.state = "error";
    $("statusText").textContent =
      error.name === "ServerVersionError" ? "服务需更新" : "服务未运行";
    $("status").title = "点击重新检查本地翻译服务";
    connectionNotice =
      error.name === "ServerVersionError"
        ? "本地翻译服务是旧版本。请在官网重新运行一键安装命令升级。"
        : error.name === "AbortError"
          ? "连接超时（5 秒）。服务可能正在启动，稍后点击右上角重试。"
          : "本地翻译服务未运行。第一次使用请在官网运行一键安装，之后会开机自动启动。";
    connectionKind = "error";
    $("setup").hidden = false;
  } finally {
    clearTimeout(timeout);
    if (request === healthRequest) {
      state.checking = false;
      renderAction();
      renderNotice();
    }
  }
}

function renderRadios(group, value) {
  for (const button of group.querySelectorAll("[data-value]")) {
    button.setAttribute("aria-checked", String(button.dataset.value === value));
    button.tabIndex = button.dataset.value === value ? 0 : -1;
  }
}

function renderDisplayMode(mode) {
  state.mode = mode;
  renderAction();
  renderRadios($("displayMode"), mode);
  $("styleGroup").disabled = mode === "translation";
  $("styleHint").hidden = mode !== "translation";
  $("styleHint").textContent =
    mode === "translation"
      ? "仅看译文时使用网页原有样式，悬停译文可看原文。"
      : "保持网页原有的字体、字号与排版。";
}

function bindRadios(group, key, onChange) {
  group.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-value]");
    if (!button || button.disabled) return;
    try {
      await chrome.storage.sync.set({ [key]: button.dataset.value });
      renderRadios(group, button.dataset.value);
      onChange?.(button.dataset.value);
    } catch {
      setNotice("设置未能保存，请重试。");
    }
  });
  group.addEventListener("keydown", (event) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    const buttons = [...group.querySelectorAll("[data-value]")].filter(
      (button) => !button.matches(":disabled"),
    );
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const next =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : buttons[
              (index +
                (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
                buttons.length) %
                buttons.length
            ];
    next.focus();
    next.click();
    event.preventDefault();
  });
}

async function pageCommand(type) {
  state.commandPending = true;
  renderAction();
  try {
    const response = await sendToTab({ type });
    if (!response?.ok) throw new Error("页面未响应");
  } catch {
    setNotice("页面操作失败，请刷新网页后重试。");
  } finally {
    state.commandPending = false;
    await refreshPageState();
    renderAction();
  }
}

$("toggle").addEventListener("click", () =>
  pageCommand(
    state.active
      ? "web-translator:restore-page"
      : "web-translator:translate-page",
  ),
);
$("retryFailed").addEventListener("click", () =>
  pageCommand("web-translator:retry-failed"),
);
$("status").addEventListener("click", checkHealth);
$("installLink").addEventListener("click", () => {
  chrome.tabs.create({ url: INSTALL_PAGE });
  window.close();
});

async function init() {
  try {
    const prefs = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    renderDisplayMode(
      MODES.includes(prefs.displayMode) ? prefs.displayMode : "bilingual",
    );
    renderRadios(
      $("translationStyle"),
      STYLES.includes(prefs.translationStyle)
        ? prefs.translationStyle
        : "plain",
    );
    bindRadios($("displayMode"), "displayMode", renderDisplayMode);
    bindRadios($("translationStyle"), "translationStyle");
    [state.tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    $("pageTitle").textContent = state.tab?.title || "当前页面";
    $("pageTitle").title = state.tab?.title || "当前页面";
    let url;
    try {
      url = new URL(state.tab?.url);
    } catch {
      /* no accessible URL */
    }
    state.supported = Boolean(
      url &&
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname !== "chromewebstore.google.com" &&
        !(
          url.hostname === "chrome.google.com" &&
          url.pathname.startsWith("/webstore")
        ) &&
        !url.pathname.toLowerCase().endsWith(".pdf"),
    );
    $("pageHost").textContent = url?.hostname || "浏览器页面";
    if (state.supported) {
      try {
        await sendToTab({ type: "web-translator:stats" });
      } catch {
        try {
          await chrome.scripting.insertCSS({
            target: { tabId: state.tab.id },
            files: ["content.css"],
          });
          await chrome.scripting.executeScript({
            target: { tabId: state.tab.id },
            files: ["content.js", "content-learn.js"],
          });
        } catch {
          state.supported = false;
        }
      }
    }
    renderPage(null);
    await Promise.all([refreshPageState(), checkHealth()]);
    const poll = setInterval(refreshPageState, 1000);
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(poll);
        healthController?.abort();
      },
      { once: true },
    );
    try {
      const commands = await chrome.commands.getAll();
      $("shortcutHint").textContent =
        commands.find((command) => command.name === "toggle-mode")?.shortcut ||
        "可在扩展设置中配置快捷键";
    } catch {
      /* keep the default keyboard hint */
    }
  } catch {
    setNotice("扩展初始化失败，请关闭弹窗并重新打开。");
  }
}
// --- vocabulary & review ---------------------------------------------------------

async function refreshLearning() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "learning:summary" });
    if (!resp?.ok) return;
    $("reviewCount").textContent = String(resp.summary.today_total);
    $("openReview").setAttribute("aria-label", `今日复习 ${resp.summary.today_total} 条`);
    $("dictState").textContent = resp.dictionary ? "离线词典已安装" : "尚未安装词典";
  } catch {
    /* service worker unavailable; keep placeholders */
  }
}

function openCenter(hash = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") + hash });
  window.close();
}

$("openReview").addEventListener("click", () => openCenter("#review"));
$("openCenter").addEventListener("click", () => openCenter(""));
$("openPanel").addEventListener("click", async () => {
  try {
    // Called directly from the click so Chrome accepts it as a user gesture.
    await chrome.sidePanel.open({ windowId: state.tab?.windowId });
    window.close();
  } catch {
    openCenter("#lookup");
  }
});

init();
refreshLearning();
