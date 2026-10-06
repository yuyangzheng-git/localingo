// Service worker: context menu for selection translation + message routing to the local server.

const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";
const AUTH_TOKEN = "web-translator-local-token";

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER_URL });
  return (serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

async function translateTexts(texts) {
  const resp = await fetch(`${await getServerUrl()}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": AUTH_TOKEN,
    },
    body: JSON.stringify({ texts }),
  });
  if (!resp.ok) {
    throw new Error(`server error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.translations;
}

async function checkHealth() {
  try {
    const resp = await fetch(`${await getServerUrl()}/health`);
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translate-selection",
    title: "翻译成中文",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "translate-selection" || !info.selectionText || !tab?.id) {
    return;
  }
  const text = info.selectionText.trim();
  if (!text) return;

  let translation;
  try {
    [translation] = await translateTexts([text]);
  } catch (err) {
    translation = `翻译失败: ${err && err.message ? err.message : err}`;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "show-result", translation });
  } catch {
    // Content script not available (e.g. chrome:// page) — nothing to do.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate-texts") {
    translateTexts(message.texts)
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true; // keep the channel open for async sendResponse
  }
  if (message?.type === "health") {
    checkHealth().then((data) => sendResponse({ ok: true, data }));
    return true;
  }
  return false;
});

// Keyboard shortcut: toggle translation on/off for the current tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-mode") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "web-translator:toggle" });
    } catch {
      // content script not available on this tab — nothing to do
    }
  }
});
