// Dictionary import off the main thread: verify, decompress and write to IndexedDB
// in batches, reporting progress; "cancel" stops it and leaves the old dictionary.

import { importPackage } from "../learning/dict-idb.js";

let controller = null;

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "cancel") {
    controller?.abort();
    return;
  }
  if (msg.type !== "import") return;
  controller = new AbortController();
  try {
    const manifest = await importPackage(msg.buffer, {
      expectedSha256: msg.expectedSha256 || undefined,
      signal: controller.signal,
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    const { license_text, ...rest } = manifest;
    self.postMessage({ type: "done", manifest: rest });
  } catch (err) {
    self.postMessage({ type: "error", cancelled: err?.name === "AbortError", message: err?.message || String(err) });
  } finally {
    controller = null;
  }
};
