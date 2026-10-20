// Learning preferences (chrome.storage.sync in the extension, localStorage on the web).

export const DEFAULT_PREFS = {
  assist: "mixed", // "zh" 更多中文帮助 | "mixed" 中英结合 | "en" 尽量英文
  selectionBar: "always", // "always" | "learn" (only in 学习阅读) | "off"
  dailyNew: 5,
  sessionMax: 20,
  speechRate: 1,
  voiceName: "",
  allowRemoteVoices: false,
  onboarded: false,
  readingDomain: "",
};

export function normalizePrefs(p = {}) {
  const out = { ...DEFAULT_PREFS, ...p };
  if (!["zh", "mixed", "en"].includes(out.assist)) out.assist = "mixed";
  if (!["always", "learn", "off"].includes(out.selectionBar)) out.selectionBar = "always";
  out.dailyNew = Math.min(Math.max(Number(out.dailyNew) || 0, 0), 50);
  out.sessionMax = Math.min(Math.max(Number(out.sessionMax) || 20, 5), 100);
  out.speechRate = [0.7, 1].includes(Number(out.speechRate)) ? Number(out.speechRate) : 1;
  out.allowRemoteVoices = !!out.allowRemoteVoices;
  out.onboarded = !!out.onboarded;
  return out;
}
