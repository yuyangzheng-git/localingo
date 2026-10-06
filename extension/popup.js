const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";

const statusEl = document.getElementById("status");
const serverUrlEl = document.getElementById("serverUrl");
const translateBtn = document.getElementById("translate");
const restoreBtn = document.getElementById("restore");
const lastStatsEl = document.getElementById("lastStats");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkHealth() {
  try {
    const url = serverUrlEl.value.trim().replace(/\/+$/, "");
    const resp = await fetch(`${url}/health`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    statusEl.textContent = `Server online — ${data.model}${data.loaded ? " (loaded)" : ""}`;
    statusEl.className = "status ok";
  } catch {
    statusEl.textContent = "Server unreachable. Start it with: uv run web-translator";
    statusEl.className = "status error";
  }
}

async function sendToTab(message) {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) throw new Error("no active tab");
  return chrome.tabs.sendMessage(tab.id, message);
}

translateBtn.addEventListener("click", async () => {
  try {
    await sendToTab({ type: "web-translator:translate-page" });
    window.close();
  } catch {
    statusEl.textContent = "Could not translate this page (content script unavailable?).";
    statusEl.className = "status error";
  }
});

restoreBtn.addEventListener("click", async () => {
  try {
    await sendToTab({ type: "web-translator:restore-page" });
    window.close();
  } catch {
    statusEl.textContent = "Could not remove translations on this page.";
    statusEl.className = "status error";
  }
});

async function init() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL });
  serverUrlEl.value = serverUrl || DEFAULT_SERVER_URL;

  try {
    const { "wt:lastStats": last } = await chrome.storage.session.get("wt:lastStats");
    if (last && last.line) lastStatsEl.textContent = last.line;
  } catch {
    // storage.session may be unavailable on old Chrome
  }

  serverUrlEl.addEventListener("change", () => {
    chrome.storage.sync.set({ serverUrl: serverUrlEl.value.trim() || DEFAULT_SERVER_URL });
    checkHealth();
  });

  checkHealth();
}

init();
