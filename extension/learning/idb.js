// Minimal promise helpers around IndexedDB (no external dependencies).

export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException("Transaction aborted", "AbortError"));
    tx.onerror = () => reject(tx.error);
  });
}

export function openDb(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = (event) => upgrade(r.result, event.oldVersion, r.transaction);
    r.onsuccess = () => {
      const db = r.result;
      // Another context upgraded the schema: close so it isn't blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("数据库被另一个页面占用，请关闭其他 LocaLingo 页面后重试"));
  });
}

/** Run `fn(stores)` in one transaction and resolve with its return value after commit. */
export async function transact(db, storeNames, mode, fn) {
  const tx = db.transaction(storeNames, mode);
  const stores = Object.fromEntries([].concat(storeNames).map((n) => [n, tx.objectStore(n)]));
  let result;
  try {
    result = await fn(stores, tx);
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    throw err;
  }
  await done(tx);
  return result;
}
