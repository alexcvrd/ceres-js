// The sample proxies (Node and Python) against a fake Ceres. Failure modes:
//   * the key is not added (every ask 401s) or leaks back to the browser                → "adds the key, never returns it"
//   * the proxy forwards any path (Ceres's other endpoints exposed)                       → "only the four endpoints"
//   * the proxy serves files outside examples/ and src/ (e.g. the key file)               → "no files outside examples and src"
//   * containment is a string-prefix test, so ../, %2e%2e%2f, an absolute path, a sibling such as examples-secret/ or a
//     symlink inside examples/ escapes the served directories                             → "containment: …"
//   * (node) a malformed request target or a client that drops mid-body kills the process → "node proxy survives …"
//   * the library and the example pages are not served from the same origin              → "serves the library and pages"
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "proxy-test-key-must-not-leak";
const ANSWER = readFileSync(new URL("./fixtures/ask-answer.json", import.meta.url));
const seen = [];
const ceres = createServer((req, res) => {
  seen.push({ path: req.url, key: req.headers["x-api-key"] });
  if (req.headers["x-api-key"] !== KEY) { res.writeHead(401).end(JSON.stringify({ detail: "bad key" })); return; }
  if (req.url === "/v1/ask") { res.writeHead(200, { "Content-Type": "application/json" }).end(ANSWER); return; }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ready: true, path: req.url }));
});
await new Promise((r) => ceres.listen(0, "127.0.0.1", r));
const CERES_URL = `http://127.0.0.1:${ceres.address().port}`;
const procs = [];

// Both proxies find their static root from their own file location, so the tests run COPIES of them inside a temporary tree
// made by mkdtemp. The escape targets (examples-secret/, a symlink in examples/) are created there, never in the repository, and
// the only thing removed afterwards is that temporary tree.
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), "ceres-js-proxy-test-"));
const ROOT = join(TMP, "site") + "/";
for (const d of ["proxy", "src", "examples", "test/fixtures"]) cpSync(join(REPO, d), join(ROOT, d), { recursive: true });
cpSync(join(REPO, "package.json"), join(ROOT, "package.json"));
const SIBLING = `${ROOT}examples-secret`, LINK = `${ROOT}examples/escape-link.json`;
mkdirSync(SIBLING); writeFileSync(`${SIBLING}/marker.txt`, "secret");
symlinkSync(`${ROOT}package.json`, LINK);
function removeTmp() {   // only the tree this run created: a fresh mkdtemp directory directly under the system temp dir
  if (dirname(TMP) === resolve(tmpdir()) && basename(TMP).startsWith("ceres-js-proxy-test-")) rmSync(TMP, { recursive: true, force: true });
}
process.on("exit", removeTmp);
after(() => { for (const p of procs) p.kill(); ceres.close(); removeTmp(); });

// GET with the path sent byte-for-byte (fetch would normalise ../ and %2e%2e before sending).
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((ok, fail) => {
    const req = request({ hostname, port, path, method: "GET" }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode)); });
    req.on("error", fail); req.end();
  });
}

async function start(cmd, args, port) {
  const p = spawn(cmd, args, { env: { ...process.env, CERES_URL, CERES_API_KEY: KEY, PORT: String(port) }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return `http://127.0.0.1:${port}`; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${cmd} proxy did not start`);
}

for (const [name, cmd, args, port] of [["node", process.execPath, [`${ROOT}proxy/node/server.mjs`], 18920],
                                       ["python", "python3", [`${ROOT}proxy/python/server.py`], 18921]]) {
  test(`${name} proxy`, async (t) => {
    const base = await start(cmd, args, port);
    await t.test("adds the key, never returns it", async () => {
      const r = await fetch(`${base}/ceres/v1/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"question":"q","lang":"en"}' });
      const text = await r.text();
      assert.equal(r.status, 200); assert.ok(!text.includes(KEY));
      assert.equal(seen.at(-1).key, KEY); assert.equal(seen.at(-1).path, "/v1/ask");
    });
    await t.test("only the four endpoints", async () => {
      for (const [m, p] of [["GET", "/ceres/docs"], ["POST", "/ceres/v1/info"], ["GET", "/ceres/v1/ask"], ["GET", "/ceres/../v1/ask"]]) {
        const before = seen.length;
        const r = await fetch(`${base}${p}`, { method: m });
        assert.ok(r.status === 404, `${m} ${p} → ${r.status}`); assert.equal(seen.length, before, `${m} ${p} reached Ceres`);
      }
      assert.equal((await fetch(`${base}/ceres/health`)).status, 200);
      assert.equal((await fetch(`${base}/ceres/v1/profiles`)).status, 200);          // memory v0: the persona list passes too
    });
    await t.test("no files outside examples and src", async () => {
      for (const p of ["/proxy/node/server.mjs", "/test/fixtures/ask-answer.json", "/examples/../package.json", "/%2e%2e/%2e%2e/etc/passwd"]) {
        assert.equal((await fetch(`${base}${p}`)).status, 404, p);
      }
    });
    await t.test("containment: ../ traversal out of examples/", async () => {
      for (const p of ["/examples/../package.json", "/src/../../../../etc/passwd", "/../package.json"]) assert.equal(await rawGet(base, p), 404, p);
    });
    await t.test("containment: percent-encoded traversal (%2e%2e%2f) is decoded, then refused", async () => {
      for (const p of ["/examples/%2e%2e%2fpackage.json", "/src/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/examples/%2E%2E/package.json"])
        assert.equal(await rawGet(base, p), 404, p);
    });
    await t.test("containment: an absolute path is not served from the filesystem root", async () => {
      const abs = `${ROOT}package.json`;
      for (const p of [`/${abs}`, `/${encodeURIComponent(abs)}`, "//etc/passwd", "/%2Fetc%2Fpasswd"]) assert.equal(await rawGet(base, p), 404, p);
    });
    await t.test("containment: a sibling whose name starts with the served directory (examples-secret/) is refused", async () => {
      assert.equal(await rawGet(base, "/examples-secret/marker.txt"), 404);
      assert.equal(await rawGet(base, "/examples/../examples-secret/marker.txt"), 404);
    });
    await t.test("containment: a symlink inside examples/ pointing outside is refused", async () => {
      assert.equal(await rawGet(base, "/examples/escape-link.json"), 404);
      assert.equal(await rawGet(base, "/examples/shared.css"), 200);         // ordinary files still served
    });
    await t.test("serves the library and pages", async () => {
      const lib = await fetch(`${base}/src/ceres-client.js`);
      assert.equal(lib.status, 200); assert.match(lib.headers.get("content-type"), /javascript/);
      for (const p of ["/", "/examples/vanilla/", "/examples/react/", "/examples/vue/"]) assert.equal((await fetch(`${base}${p}`)).status, 200, p);
    });
  });
}

// Raw socket helpers: fetch cannot send a broken target or hang up half-way through a body.
import { connect } from "node:net";
function rawSocket(port, bytes, { hangUpAfterWrite = false } = {}) {
  return new Promise((ok) => {
    const sock = connect(port, "127.0.0.1", () => { sock.write(bytes); if (hangUpAfterWrite) setTimeout(() => sock.destroy(), 50); });
    let out = ""; sock.on("data", (d) => { out += d; }); sock.on("error", () => {}); sock.on("close", () => ok(out));
    setTimeout(() => { sock.destroy(); }, 1500);
  });
}

test("node proxy survives a malformed request target and a client that hangs up mid-body", async (t) => {
  // Bug caught: new URL(req.url) and the request-body loop sat outside any try, so one bad request crashed the whole proxy.
  const port = 18922;
  const base = await start(process.execPath, [`${ROOT}proxy/node/server.mjs`], port);
  const alive = async () => (await fetch(`${base}/ceres/health`)).status === 200;
  await t.test("a request target that is not a valid URL gets 400, not a crash", async () => {
    const reply = await rawSocket(port, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.ok(await alive());
  });
  await t.test("a client that promises a body and hangs up does not crash the proxy", async () => {
    await rawSocket(port, "POST /ceres/v1/ask HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{\"quest", { hangUpAfterWrite: true });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(await alive());
  });
});
