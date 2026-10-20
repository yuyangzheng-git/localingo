const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
const DEFAULT_SETTINGS = {
  displayMode: "bilingual",
  translationStyle: "plain",
};
const STYLES = ["plain", "muted", "underline"];
const $ = (id) => document.getElementById(id);
const state = {
  tab: null,
  supported: false,
  active: false,
  busy: false,
  authorized: false,
  checking: true,
  commandPending: false,
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
  $("toggle").disabled =
    state.commandPending ||
    !state.supported ||
    (!state.active && (!state.authorized || state.checking));
  $("toggle").dataset.active = String(state.active);
  $("toggleLabel").textContent = !state.supported
    ? "此页面暂不支持"
    : state.commandPending
      ? "正在处理…"
      : state.active
        ? state.busy
          ? "停止并恢复原文"
          : "恢复原文"
        : state.checking
          ? "正在检查连接…"
          : !state.authorized
            ? "请先连接本地服务"
            : "翻译此页";
  $("toggleIcon").textContent = state.active ? "↶" : "↗";
  $("actionHint").textContent = state.active
    ? "可随时关闭弹窗，翻译会在当前页面继续。"
    : "优先翻译可见段落，继续滚动即可接着翻译。";
  $("retryFailed").disabled =
    state.busy || !state.authorized || state.commandPending;
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

// Match the extension's existing loopback-only host permissions.
function localServerUrl(value) {
  const url = new URL(value.trim() || DEFAULT_SERVER_URL);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("请输入 http://127.0.0.1:端口 或 http://localhost:端口。");
  }
  return url.origin;
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
    const { serverUrl } = await chrome.storage.sync.get({
      serverUrl: DEFAULT_SERVER_URL,
    });
    const { authToken } = await chrome.storage.local.get({ authToken: "" });
    const url = localServerUrl(serverUrl);
    const response = await fetch(`${url}/health`, {
      headers: { "X-Auth-Token": authToken },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (request !== healthRequest) return;
    if (typeof data.authorized !== "boolean") {
      const error = new Error("服务版本不兼容");
      error.name = "ServerVersionError";
      throw error;
    }
    state.authorized = data.authorized === true;
    $("status").dataset.state = state.authorized ? "ok" : "warn";
    $("statusText").textContent = state.authorized ? "本地已连接" : "需要令牌";
    $("status").title = state.authorized
      ? `模型：${data.model || "本地模型"}${data.loaded ? "（已加载）" : "（首次翻译时加载）"}。点击重新检查。`
      : "保存正确令牌后重试。";
    $("connectionSummary").textContent = state.authorized
      ? "已验证连接"
      : "请填写令牌";
    connectionNotice = state.authorized
      ? ""
      : authToken
        ? "服务已连接，但令牌不正确。请重新复制启动日志中的令牌。"
        : "服务已连接。在「连接与设置」粘贴令牌后即可开始。";
    connectionKind = "warn";
    if (!state.authorized) $("settings").open = true;
    $("settingsFeedback").textContent = state.authorized
      ? "连接已验证，设置已保存。首次翻译可能需要加载模型。"
      : "请检查令牌，然后点击「保存并连接」。";
  } catch (error) {
    if (request !== healthRequest) return;
    state.authorized = false;
    $("status").dataset.state = "error";
    $("statusText").textContent =
      error.name === "ServerVersionError" ? "服务需更新" : "服务未连接";
    $("status").title = "点击重新连接本地服务";
    $("connectionSummary").textContent = "需要连接";
    connectionNotice =
      error.name === "ServerVersionError"
        ? "当前服务仍是旧版接口。请从最新 localingo 项目目录重新启动服务，再复制新令牌连接。"
        : error.name === "AbortError"
          ? "连接超时（5 秒）。确认本地服务已启动，然后点击右上角重试。"
          : "无法连接本地服务。请先运行下方启动命令，再保存连接设置。";
    connectionKind = "error";
    $("settings").open = true;
    $("settingsFeedback").textContent = connectionNotice;
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
$("revealToken").addEventListener("click", () => {
  const show = $("authToken").type === "password";
  $("authToken").type = show ? "text" : "password";
  $("revealToken").textContent = show ? "隐藏" : "显示";
  $("revealToken").setAttribute("aria-label", show ? "隐藏令牌" : "显示令牌");
  $("revealToken").setAttribute("aria-pressed", String(show));
});
$("connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("serverUrl").removeAttribute("aria-invalid");
  let serverUrl;
  try {
    serverUrl = localServerUrl($("serverUrl").value);
  } catch (error) {
    $("serverUrl").setAttribute("aria-invalid", "true");
    $("settingsFeedback").textContent = error.message;
    $("serverUrl").focus();
    return;
  }
  $("saveConnection").disabled = true;
  try {
    await chrome.storage.sync.set({ serverUrl });
    await chrome.storage.local.set({ authToken: $("authToken").value.trim() });
    $("serverUrl").value = serverUrl;
    await checkHealth();
  } catch {
    $("settingsFeedback").textContent = "设置未能保存，请重试。";
  } finally {
    $("saveConnection").disabled = false;
  }
});
$("copyCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText("uv run web-translator");
    $("copyCommand").textContent = "已复制";
  } catch {
    $("settingsFeedback").textContent = "复制未成功，可选中命令手动复制。";
  }
});

async function init() {
  try {
    const prefs = await chrome.storage.sync.get({
      serverUrl: DEFAULT_SERVER_URL,
      ...DEFAULT_SETTINGS,
    });
    $("serverUrl").value = prefs.serverUrl || DEFAULT_SERVER_URL;
    const { authToken } = await chrome.storage.local.get({ authToken: "" });
    $("authToken").value = authToken;
    renderDisplayMode(
      prefs.displayMode === "translation" ? "translation" : "bilingual",
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
            files: ["content.js"],
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
init();
