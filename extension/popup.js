const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
const DEFAULT_SETTINGS = { displayMode: "bilingual", translationStyle: "plain" };
const STYLES = ["plain", "muted", "underline"];

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const noticeEl = document.getElementById("notice");
const toggleBtn = document.getElementById("toggle");
const toggleLabel = document.getElementById("toggleLabel");
const lastStatsEl = document.getElementById("lastStats");
const displayModeEl = document.getElementById("displayMode");
const styleGroupEl = document.getElementById("styleGroup");
const translationStyleEl = document.getElementById("translationStyle");
const settingsEl = document.getElementById("settings");
const serverUrlEl = document.getElementById("serverUrl");
const authTokenEl = document.getElementById("authToken");
const revealTokenBtn = document.getElementById("revealToken");

let pageActive = false;

function setStatus(state, text, title = "") {
  statusEl.dataset.state = state;
  statusTextEl.textContent = text;
  statusEl.title = title;
}

function setNotice(text, kind = "error") {
  noticeEl.hidden = !text;
  noticeEl.textContent = text || "";
  noticeEl.dataset.kind = kind;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) throw new Error("no active tab");
  return chrome.tabs.sendMessage(tab.id, message);
}

async function checkHealth() {
  setStatus("checking", "检查中");
  try {
    const url = serverUrlEl.value.trim().replace(/\/+$/, "");
    const resp = await fetch(`${url}/health`, {
      headers: { "X-Auth-Token": authTokenEl.value.trim() },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.authorized) {
      setStatus("warn", "需要令牌", data.model);
      setNotice(
        authTokenEl.value.trim()
          ? "令牌不正确，请从服务器输出中重新复制。"
          : "服务器已连接，请在下方粘贴访问令牌。",
        "warn",
      );
      settingsEl.open = true;
      return;
    }
    setStatus("ok", data.loaded ? "就绪" : "在线", `模型：${data.model}${data.loaded ? "（已加载）" : "（首次翻译时加载）"}`);
    setNotice("");
  } catch {
    setStatus("error", "离线");
    setNotice("无法连接翻译服务器。请在终端运行 uv run web-translator。");
    settingsEl.open = true;
  }
}

function renderToggle() {
  toggleBtn.dataset.active = String(pageActive);
  toggleLabel.textContent = pageActive ? "显示原文" : "翻译此页";
}

async function refreshPageState() {
  try {
    const resp = await sendToTab({ type: "web-translator:stats" });
    pageActive = !!(resp && resp.active);
    toggleBtn.disabled = false;
  } catch {
    // No content script: chrome:// pages, the Web Store, or a tab opened before install.
    toggleBtn.disabled = true;
    toggleLabel.textContent = "此页面无法翻译";
    return;
  }
  renderToggle();
}

function renderRadios(group, value) {
  for (const btn of group.querySelectorAll("[data-value]")) {
    btn.setAttribute("aria-checked", String(btn.dataset.value === value));
    btn.tabIndex = btn.dataset.value === value ? 0 : -1;
  }
}

function bindRadios(group, key, onChange) {
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    renderRadios(group, btn.dataset.value);
    chrome.storage.sync.set({ [key]: btn.dataset.value });
    if (onChange) onChange(btn.dataset.value);
  });
  // Arrow keys move between options, like native radio buttons.
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const buttons = [...group.querySelectorAll("[data-value]")];
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
    e.preventDefault();
  });
}

function renderDisplayMode(mode) {
  renderRadios(displayModeEl, mode);
  // Styles only apply to the bilingual layout.
  styleGroupEl.dataset.disabled = String(mode === "translation");
}

toggleBtn.addEventListener("click", async () => {
  try {
    await sendToTab({ type: pageActive ? "web-translator:restore-page" : "web-translator:translate-page" });
    window.close();
  } catch {
    setNotice("无法在此页面操作，请刷新页面后重试。");
  }
});

revealTokenBtn.addEventListener("click", () => {
  const show = authTokenEl.type === "password";
  authTokenEl.type = show ? "text" : "password";
  revealTokenBtn.textContent = show ? "隐藏" : "显示";
  revealTokenBtn.setAttribute("aria-label", show ? "隐藏令牌" : "显示令牌");
});

async function init() {
  const { serverUrl, ...prefs } = await chrome.storage.sync.get({
    serverUrl: DEFAULT_SERVER_URL,
    ...DEFAULT_SETTINGS,
  });
  serverUrlEl.value = serverUrl || DEFAULT_SERVER_URL;
  const { authToken } = await chrome.storage.local.get({ authToken: "" });
  authTokenEl.value = authToken;

  renderDisplayMode(prefs.displayMode);
  renderRadios(translationStyleEl, STYLES.includes(prefs.translationStyle) ? prefs.translationStyle : "plain");
  bindRadios(displayModeEl, "displayMode", renderDisplayMode);
  bindRadios(translationStyleEl, "translationStyle");

  try {
    const { "wt:lastStats": last } = await chrome.storage.session.get("wt:lastStats");
    if (last && last.line) lastStatsEl.textContent = `上次：${last.line}`;
  } catch {
    // storage.session may be unavailable on old Chrome
  }

  serverUrlEl.addEventListener("change", () => {
    chrome.storage.sync.set({ serverUrl: serverUrlEl.value.trim() || DEFAULT_SERVER_URL });
    checkHealth();
  });

  authTokenEl.addEventListener("change", () => {
    chrome.storage.local.set({ authToken: authTokenEl.value.trim() });
    checkHealth();
  });

  refreshPageState();
  checkHealth();
}

init();
