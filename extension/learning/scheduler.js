// Review scheduling, `simple-v1` (PRD §11.3). A transparent fixed ladder, not a
// memory model and not Anki's algorithm.
//
// A card's state is derived by replaying its review events in order, so merging
// events from several devices (sync) needs no conflict resolution: the union of
// events always yields the same state everywhere.

export const SCHEDULER_VERSION = "simple-v1";
export const LEVEL_DAYS = [1, 3, 7, 14, 30, 60];
export const MAX_LEVEL = LEVEL_DAYS.length - 1;
export const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };
export const RATING_LABELS = { 1: "忘记", 2: "困难", 3: "记得", 4: "很熟" };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export function newState() {
  return { stage: "new", level: 0, due_at: null, reps: 0, lapses: 0, last_reviewed_at: null };
}

/** Next state after rating a card at time `now` (ms since epoch, UTC). */
export function nextState(state, rating, now) {
  const s = { ...newState(), ...state };
  const out = { ...s, reps: s.reps + 1, last_reviewed_at: now };
  if (![1, 2, 3, 4].includes(rating)) throw new Error(`invalid rating ${rating}`);

  if (s.stage === "new" || s.stage === "learning") {
    if (rating === 1) return { ...out, stage: "learning", level: 0, due_at: now + 10 * MINUTE };
    if (rating === 2) return { ...out, stage: "learning", level: 0, due_at: now + DAY };
    if (rating === 3) return { ...out, stage: "review", level: 0, due_at: now + DAY };
    return { ...out, stage: "review", level: 1, due_at: now + 3 * DAY };
  }

  // review, level n
  const n = Math.min(Math.max(s.level, 0), MAX_LEVEL);
  if (rating === 1) {
    return { ...out, stage: "learning", level: 0, lapses: s.lapses + 1, due_at: now + 10 * MINUTE };
  }
  if (rating === 2) {
    const days = Math.max(1, Math.floor(LEVEL_DAYS[n] / 2));
    return { ...out, stage: "review", level: n, due_at: now + days * DAY };
  }
  const level = Math.min(n + (rating === 3 ? 1 : 2), MAX_LEVEL);
  return { ...out, stage: "review", level, due_at: now + LEVEL_DAYS[level] * DAY };
}

/** Deterministic event order: by rating time, then id. */
export function sortEvents(events) {
  return [...events].sort((a, b) => a.rated_at - b.rated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Replay a card's (non-deleted) events into its current state. */
export function replay(events) {
  let state = newState();
  for (const e of sortEvents(events)) {
    if (e.deleted_at) continue;
    state = nextState(state, e.rating, e.rated_at);
  }
  return state;
}

/** Preview the interval each rating would give, for the button captions. */
export function previewIntervals(state, now) {
  const out = {};
  for (const r of [1, 2, 3, 4]) out[r] = nextState(state, r, now).due_at - now;
  return out;
}

export function formatInterval(ms) {
  if (ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)} 分钟`;
  // Anything from ~22 hours counts as a day, so "due in 1 day" doesn't read "24 小时".
  if (ms < 22 * 60 * MINUTE) return `${Math.round(ms / (60 * MINUTE))} 小时`;
  return `${Math.max(1, Math.round(ms / DAY))} 天`;
}

/** Local calendar day (in the user's time zone) of a timestamp, e.g. "2026-10-20". */
export function localDay(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
