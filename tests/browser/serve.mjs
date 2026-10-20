// Run: node tests/browser/serve.mjs; open http://127.0.0.1:8791/tests/browser/preview.html
import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) {
        res.writeHead(403).end();
        return;
      }
      let content = await readFile(path);
      if (url.pathname === "/extension/popup.html")
        content = content
          .toString()
          .replace(
            '<script src="popup.js">',
            '<script src="/tests/browser/chrome-mock.js"></script><script src="popup.js">',
          );
      res
        .writeHead(200, {
          "Content-Type": mime[extname(path)] || "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(content);
    } catch {
      res.writeHead(404).end("Not found");
    }
  })
  .listen(8791, "127.0.0.1", () =>
    console.log(
      "LocaLingo fixture: http://127.0.0.1:8791/tests/browser/preview.html",
    ),
  );
