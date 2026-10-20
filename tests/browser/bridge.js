// Same-origin browser fixture only. Not included in the extension manifest.
const scenario =
  new URLSearchParams(location.search).get("scenario") || "ready";
window.fixture = {
  scenario,
  connected: scenario !== "offline",
  failNext: scenario === "failed",
  sync: {
    serverUrl: "http://127.0.0.1:8765",
    displayMode: "bilingual",
    translationStyle: "plain",
  },
  local: {
    authToken: scenario === "token" ? "" : "fixture-token-not-a-real-secret",
  },
  listeners: [],
  pageHandlers: [],
};
document.querySelector("#connect").onclick = () => {
  window.fixture.connected = true;
};
document.querySelector("#append").onclick = () => {
  const doc = document.querySelector("#article").contentDocument;
  const p = doc.createElement("p");
  p.textContent =
    "New paragraphs should appear naturally, translated without restarting the page.";
  doc.querySelector("main").prepend(p);
};
document.querySelector("#change").onclick = () => {
  const doc = document.querySelector("#article").contentDocument;
  const original = doc.querySelector("#changing .web-translator-orig");
  const paragraph = original || doc.querySelector("#changing");
  if (original)
    paragraph.textContent =
      "This sentence changed while reading, and the translation should follow it.";
  else
    paragraph.firstChild.textContent =
      "This sentence changed while reading, and the translation should follow it.";
};
