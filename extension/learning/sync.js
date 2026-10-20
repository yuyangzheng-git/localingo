// Sync client for the LocaLingo server (see server/README.md for the protocol).
//
//   push: POST /api/sync/push  { device_id, changes: {store: [records]} }
//   pull: GET  /api/sync/pull?since=<cursor>&limit=<n>  -> { changes, cursor, more }
//
// Records are merged last-writer-wins on updated_at; review events are append-only,
// and card state is re-derived from events, so concurrent reviews on two devices
// never conflict.

export class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Small fetch wrapper with bearer auth, JSON and a timeout. */
export class ApiClient {
  constructor({ baseUrl = "", token = "", timeoutMs = 20000, fetchImpl } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await this.fetch(this.baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: "omit",
      });
    } catch (err) {
      throw new SyncError(err?.name === "AbortError" ? "连接服务器超时" : "无法连接同步服务器");
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 401) throw new SyncError("登录已失效，请重新登录", 401);
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.json()).detail || "";
      } catch {
        // not JSON
      }
      throw new SyncError(typeof detail === "string" && detail ? detail : `服务器错误 ${resp.status}`, resp.status);
    }
    return resp.status === 204 ? null : resp.json();
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body) {
    return this.request("POST", path, body ?? {});
  }
}

export async function login(baseUrl, username, password, { deviceLabel = "", fetchImpl } = {}) {
  const api = new ApiClient({ baseUrl, fetchImpl });
  const data = await api.post("/api/auth/login", { username, password, device_label: deviceLabel });
  return { token: data.token, user: data.user };
}

/**
 * Run one full sync: push local changes in pages, then pull remote changes.
 * Returns { pushed, pulled, cursor }.
 */
export async function syncOnce(store, api, { pageSize = 500, maxPages = 50 } = {}) {
  const device = await store.deviceId();
  let pushed = 0;
  for (let page = 0; page < maxPages; page++) {
    const dirty = await store.dirtyRecords(pageSize);
    const count = Object.values(dirty).reduce((n, rows) => n + rows.length, 0);
    if (!count) break;
    const body = { device_id: device, changes: Object.fromEntries(Object.entries(dirty).map(([k, rows]) => [k, rows.map(({ dirty: _d, ...r }) => r)])) };
    await api.post("/api/sync/push", body);
    await store.markPushed(dirty);
    pushed += count;
    if (count < pageSize) break;
  }

  let cursor = (await store.getMeta("sync_cursor")) || 0;
  let pulled = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await api.get(`/api/sync/pull?since=${encodeURIComponent(cursor)}&limit=${pageSize}`);
    if (data.changes) {
      const counts = await store.mergeRecords(data.changes);
      pulled += Object.values(counts).reduce((a, b) => a + b, 0);
    }
    cursor = data.cursor;
    await store.setMeta("sync_cursor", cursor);
    if (!data.more) break;
  }
  await store.setMeta("last_sync_at", Date.now());
  return { pushed, pulled, cursor };
}
