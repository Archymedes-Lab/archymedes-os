// Serves the static export like the Worker does: /path/ → /path/index.html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const root = new URL("../out/", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain", ".woff2": "font/woff2" };
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, p);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(root, "404.html");
    res.statusCode = 404;
  }
  try {
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(Number(process.env.PORT ?? 4791));
