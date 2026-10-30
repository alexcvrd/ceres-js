// Sample backend pass-through for ceres-client.js (Node 18+, no dependencies). PoC.
//
// It does two jobs:  /ceres/*  → Ceres, with the API key added here (the browser never sees it); only the four Ceres
// endpoints the client uses are allowed.  /*  → the example pages and the library (static files), so pages and API share
// one origin and no CORS is needed.  In a real app, the /ceres route goes into your existing backend, behind your login.
//
//   CERES_URL=http://127.0.0.1:8300 CERES_API_KEY_FILE=/path/to/ceres-api-key node proxy/node/server.mjs   (port 8320)

import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CERES_URL = (process.env.CERES_URL || "http://127.0.0.1:8300").replace(/\/+$/, "");
const KEY = process.env.CERES_API_KEY || (process.env.CERES_API_KEY_FILE ? readFileSync(process.env.CERES_API_KEY_FILE, "utf8").trim() : "");
const PORT = Number(process.env.PORT || 8320);
const HOST = process.env.HOST || "127.0.0.1";
const ALLOWED = new Set(["GET /health", "GET /v1/info", "GET /v1/profiles", "POST /v1/ask"]);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".json": "application/json" };

// Send an error only while the socket can still carry one; otherwise just drop the connection. Never throws.
function fail(res, status, detail) {
  try {
    if (res.headersSent || res.destroyed || !res.writable) { res.destroy(); return; }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ detail }));
  } catch { /* the client is gone */ }
}

async function passThrough(req, res, path) {
  if (!ALLOWED.has(`${req.method} ${path}`)) { res.writeHead(404).end(); return; }
  const chunks = [];
  try { for await (const c of req) chunks.push(c); }
  catch { fail(res, 400, "The request body could not be read"); return; }      // the client disconnected or sent a broken body
  const headers = { "Content-Type": "application/json", ...(KEY ? { "X-API-Key": KEY } : {}) };
  // This sample does not authenticate users. A real backend must verify the user's session or token here
  // (req.headers.authorization) before forwarding.
  try {
    const r = await fetch(CERES_URL + path, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
    res.end(body);
  } catch {
    fail(res, 502, "Ceres is not reachable");
  }
}

// Static files come only from these directories. A request is served only when its real path (after decoding,
// normalisation and symlink resolution) lies inside one of them; anything else is a 404.
const SERVED = ["examples", "src"].map((d) => realpathSync(join(ROOT, d)));
const inside = (dir, p) => { const rel = relative(dir, p); return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)); };

async function resolveServed(path) {
  let decoded;
  try { decoded = decodeURIComponent(path === "/" ? "/examples/index.html" : path); } catch { return null; }
  if (decoded.includes("\0")) return null;
  let real = await realpath(join(ROOT, decoded)).catch(() => null);
  if (real && (await stat(real)).isDirectory()) real = await realpath(join(real, "index.html")).catch(() => null);
  return real && SERVED.some((d) => inside(d, real)) && (await stat(real)).isFile() ? real : null;
}

async function serveFile(res, path) {
  try {
    const file = await resolveServed(path);
    if (!file) { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
}

// One guard around the whole handler: a bad request target, a dropped connection or any other error in a request
// answers that request (400/404/502, or a closed socket) and never stops the process.
async function handle(req, res) {
  let path;
  try { path = new URL(req.url, "http://x").pathname; }
  catch { fail(res, 400, "Bad request target"); return; }
  if (path.startsWith("/ceres/")) return passThrough(req, res, path.slice("/ceres".length));
  return serveFile(res, path);
}

createServer((req, res) => {
  req.on("error", () => {});          // an error event nobody listens to would throw
  res.on("error", () => {});
  handle(req, res).catch(() => fail(res, 500, "Internal error"));
}).listen(PORT, HOST, () => console.log(`ceres-client demo on http://${HOST}:${PORT}  →  Ceres ${CERES_URL}${KEY ? "" : "  (no key: Ceres must run with --no-auth)"}`));
