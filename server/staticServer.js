import { createReadStream, promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Mirrors nginx's local routing for dev use: `root client/` with a
// `/shared/` alias, `try_files $uri $uri/ =404` (no SPA fallback — an
// unknown path is a real 404, not index.html). In production nginx
// serves these paths directly and this code never runs.
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(serverDir, "..", "client");
const sharedDir = path.join(serverDir, "..", "shared");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream";
}

// Resolves a URL path to a file under `root`, refusing to escape it
// (blocks `..` path traversal regardless of how it's encoded).
function resolveSafe(root, urlPath) {
  const resolved = path.normalize(path.join(root, urlPath));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

async function trySend(res, filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    return trySend(res, path.join(filePath, "index.html"));
  }
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  createReadStream(filePath).pipe(res);
  return true;
}

// Returns true if the request was served (or definitively 404'd as a
// static-file request), false if the caller should try something else.
export async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const root = url.pathname.startsWith("/shared/") ? sharedDir : clientDir;
  const relativePath = url.pathname.startsWith("/shared/")
    ? url.pathname.slice("/shared".length)
    : url.pathname;

  const filePath = resolveSafe(root, relativePath === "/" ? "/index.html" : relativePath);
  if (!filePath) {
    res.writeHead(400);
    res.end();
    return true;
  }

  if (await trySend(res, filePath)) return true;

  res.writeHead(404);
  res.end();
  return true;
}
