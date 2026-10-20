// Offline dictionary stored in the extension's own IndexedDB.
//
// Imports are versioned: records of a new package are written under its own `pkg`
// tag and only become active after the whole file has been written; the previous
// package is removed afterwards. A failed or cancelled import therefore never
// breaks the dictionary that was already installed.

import { openDb, req, transact } from "./idb.js";

const DB_NAME = "localingo-dict";
const DB_VERSION = 1;
const BATCH = 2000;

let dbPromise = null;

export function openDictDb() {
  if (!dbPromise) {
    dbPromise = openDb(DB_NAME, DB_VERSION, (db) => {
      const entries = db.createObjectStore("entries", { keyPath: "id", autoIncrement: true });
      entries.createIndex("pkg_k", ["pkg", "k"]);
      entries.createIndex("pkg", "pkg");
      const forms = db.createObjectStore("forms", { keyPath: ["pkg", "k"] });
      forms.createIndex("pkg", "pkg");
      db.createObjectStore("meta", { keyPath: "key" });
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function activeManifest(db) {
  const row = await transact(db, "meta", "readonly", ({ meta }) => req(meta.get("active")));
  return row ? row.manifest : null;
}

export class IdbDictionary {
  async info() {
    return activeManifest(await openDictDb());
  }

  async getEntries(keys) {
    const db = await openDictDb();
    const manifest = await activeManifest(db);
    const out = new Map();
    if (!manifest) return out;
    await transact(db, "entries", "readonly", async ({ entries }) => {
      const idx = entries.index("pkg_k");
      const rows = await Promise.all(keys.map((k) => req(idx.getAll([manifest.pkg, k]))));
      keys.forEach((k, i) => {
        if (rows[i].length) out.set(k, rows[i].map(stripInternal));
      });
    });
    return out;
  }

  async getForms(keys) {
    const db = await openDictDb();
    const manifest = await activeManifest(db);
    const out = new Map();
    if (!manifest) return out;
    await transact(db, "forms", "readonly", async ({ forms }) => {
      const rows = await Promise.all(keys.map((k) => req(forms.get([manifest.pkg, k]))));
      keys.forEach((k, i) => {
        if (rows[i]) out.set(k, { k, of: rows[i].of });
      });
    });
    return out;
  }
}

function stripInternal(row) {
  const { id, pkg, type, ...entry } = row;
  return entry;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function* ndjsonLines(buffer) {
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream());
  const reader = stream.getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let nl;
    while ((nl = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  if (rest.trim()) yield rest;
}

async function deletePackage(db, pkg) {
  for (const store of ["entries", "forms"]) {
    await transact(db, store, "readwrite", async (stores) => {
      const keys = await req(stores[store].index("pkg").getAllKeys(IDBKeyRange.only(pkg)));
      for (const key of keys) stores[store].delete(key);
    });
  }
}

/**
 * Import a gzipped NDJSON package (see scripts/build_dict.py).
 * options: { expectedSha256, onProgress({done, total, phase}), signal }
 * Returns the activated manifest.
 */
export async function importPackage(buffer, { expectedSha256, onProgress = () => {}, signal } = {}) {
  onProgress({ phase: "verify", done: 0, total: 0 });
  const actual = await sha256Hex(buffer);
  if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
    throw new Error("词典文件校验失败（SHA-256 不一致），已停止导入，原词典未受影响");
  }
  const db = await openDictDb();
  const lines = ndjsonLines(buffer);
  const first = await lines.next();
  if (first.done) throw new Error("词典文件是空的");
  let manifest;
  try {
    manifest = JSON.parse(first.value);
  } catch {
    throw new Error("无法识别的词典文件格式");
  }
  if (manifest.type !== "package" || manifest.schema_version !== 1) {
    throw new Error("不是 LocaLingo 词典包，或版本不受支持");
  }
  const pkg = `${manifest.package_id}@${manifest.source_version}#${actual.slice(0, 12)}`;
  const total = (manifest.entries || 0) + (manifest.forms || 0);
  let count = 0;
  let batch = [];

  const flush = async () => {
    const rows = batch;
    batch = [];
    await transact(db, ["entries", "forms"], "readwrite", ({ entries, forms }) => {
      for (const r of rows) {
        if (r.type === "entry") entries.add({ ...r, pkg });
        else if (r.type === "form") forms.put({ pkg, k: r.k, of: r.of });
      }
    });
    onProgress({ phase: "import", done: count, total });
  };

  try {
    await deletePackage(db, pkg); // leftovers of an earlier interrupted import of the same file
    for await (const line of lines) {
      if (signal?.aborted) throw new DOMException("导入已取消", "AbortError");
      const r = JSON.parse(line);
      if (r.type !== "entry" && r.type !== "form") continue;
      batch.push(r);
      count++;
      if (batch.length >= BATCH) await flush();
    }
    if (batch.length) await flush();
    if (signal?.aborted) throw new DOMException("导入已取消", "AbortError");
  } catch (err) {
    await deletePackage(db, pkg).catch(() => {});
    throw err;
  }

  const { license_text, type, ...rest } = manifest;
  const active = { ...rest, pkg, sha256: actual, bytes: buffer.byteLength, imported_at: new Date().toISOString(), license_text };
  const previous = await activeManifest(db);
  await transact(db, "meta", "readwrite", ({ meta }) => {
    meta.put({ key: "active", manifest: active });
  });
  if (previous && previous.pkg !== pkg) {
    onProgress({ phase: "cleanup", done: count, total });
    await deletePackage(db, previous.pkg).catch(() => {});
  }
  onProgress({ phase: "done", done: count, total });
  return active;
}

export async function removeDictionary() {
  const db = await openDictDb();
  const previous = await activeManifest(db);
  await transact(db, "meta", "readwrite", ({ meta }) => {
    meta.delete("active");
  });
  if (previous) await deletePackage(db, previous.pkg);
}

/** Rough storage figures for the data settings page. */
export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
