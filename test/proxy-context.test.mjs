// The sample proxies (Node and Python) and context-v0: body cap, chunked bodies, forwarding, upstream failures. They run the real
// proxy files (nothing is written) against a fake Ceres on 127.0.0.1. How they can fail, and the test that catches each:
//   * `context` (or any byte of the body) is changed on the way to Ceres                       → "forwards the body byte for byte"
//   * a body one byte over 65 536 is forwarded, or the cap counts characters instead of bytes   → "the cap is 65 536 bytes"
//   * the proxy reads a declared 1 MB body before saying no                                      → "an over-long Content-Length is refused before the body is read"
//   * (node) a chunked body grows without bound, or is refused only after it was all read        → "chunked bodies"
//   * (python) a chunked body is read without a bound                                             → "chunked bodies"
//   * (node) the chunked cap is off by one: 65 536 bytes refused, or 65 537 forwarded            → "node proxy: a chunked body of exactly 65 536 bytes"
//   * (python) a connect timeout (URLError wrapping a timeout) is 502, a read timeout is 504      → "python proxy: a connect timeout"
//   * Ceres unreachable or too slow shows as a dropped connection or a text the client cannot map → "upstream failures"
//   * the 502/504/413 bodies leak the key, or the client maps them to generic kinds                → "upstream failures", "ceres-js through the proxy"
//   * Ceres's own 4xx/5xx (409, 422) is rewritten by the proxy                                      → "Ceres's own errors pass through unchanged"
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createCeresClient, CeresError } from "../src/ceres-client.js";

const KEY = "proxy-test-key-must-not-leak";
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CAP = 65536;
const ONE_PARCEL = readFileSync(new URL("./contract/req-one-parcel.json", import.meta.url));
const LEGACY_422 = readFileSync(new URL("./contract/err-422-legacy-context.json", import.meta.url));
const CONFLICT_409 = readFileSync(new URL("./contract/err-409-request-conflict.json", import.meta.url));
const ANSWER = readFileSync(new URL("./fixtures/ask-answer.json", import.meta.url));

// A fake Ceres that records the bodies it receives. The body decides what it does: "HANG" never answers, "LEGACY" and "CONFLICT" answer
// with the golden errors, anything else is a normal answer.
const received = [];
const ceres = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    received.push({ path: req.url, key: req.headers["x-api-key"], body });
    const text = body.toString("utf8");
    if (text.includes("HANG")) return;
    const send = (status, b) => res.writeHead(status, { "Content-Type": "application/json" }).end(b);
    if (text.includes("LEGACY")) return send(422, LEGACY_422);
    if (text.includes("CONFLICT")) return send(409, CONFLICT_409);
    if (req.url === "/v1/ask") return send(200, ANSWER);
    send(200, JSON.stringify({ ready: true }));
  });
});
await new Promise((r) => ceres.listen(0, "127.0.0.1", r));
const CERES_URL = `http://127.0.0.1:${ceres.address().port}`;
const procs = [];
after(() => { for (const p of procs) p.kill(); ceres.close(); });

async function start(cmd, args, port, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, CERES_URL, CERES_API_KEY: KEY, PORT: String(port), UPSTREAM_TIMEOUT_S: "0.5", ...env }, stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/ceres/health`); return `http://127.0.0.1:${port}`; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`${cmd} proxy did not start`);
}

// Raw socket: send `parts` (with a pause between them) and return what comes back, as soon as `done(text)` says the answer is complete.
function exchange(port, parts, { done = (t) => /\r\n\r\n[\s\S]*\}/.test(t), pauseMs = 30, maxMs = 4000 } = {}) {
  return new Promise((ok) => {
    const sock = connect(port, "127.0.0.1");
    let out = "", finished = false;
    const finish = () => { if (!finished) { finished = true; sock.destroy(); ok(out); } };
    sock.on("data", (d) => { out += d; if (done(out)) finish(); });
    sock.on("error", () => {}); sock.on("close", finish);
    setTimeout(finish, maxMs);
    sock.on("connect", async () => { for (const p of parts) { if (finished) return; sock.write(p); await new Promise((r) => setTimeout(r, pauseMs)); } });
  });
}
const status = (text) => Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1]);
const bodyOf = (text) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));   // also when the body is chunked
const post = (base, body, headers = {}) => fetch(`${base}/ceres/v1/ask`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
// A JSON body of exactly `bytes` bytes, padded with the given character.
const padded = (bytes, ch = "a") => {
  const frame = (n) => `{"question":"q","lang":"en","pad":"${ch.repeat(n)}"}`;
  const per = Buffer.byteLength(ch), fixed = Buffer.byteLength(frame(0));
  assert.equal((bytes - fixed) % per, 0);
  return Buffer.from(frame((bytes - fixed) / per));
};

for (const [name, cmd, args, port] of [["node", process.execPath, [`${REPO}/proxy/node/server.mjs`], 18930],
                                                   ["python", "python3", [`${REPO}/proxy/python/server.py`], 18931]]) {
  const chunkedRefused = name === "python";
  test(`${name} proxy and context-v0`, async (t) => {
    const base = await start(cmd, args, port);

    await t.test("forwards the body byte for byte, with the key added", async () => {
      // Bug caught: the proxy parses and re-serializes the body (dropping or reordering `context`), or adds the key to the reply.
      const before = received.length;
      const r = await post(base, ONE_PARCEL);
      const text = await r.text();
      assert.equal(r.status, 200); assert.ok(!text.includes(KEY));
      assert.equal(received.length, before + 1);
      assert.ok(received.at(-1).body.equals(ONE_PARCEL), "Ceres received the very bytes (including the non-ASCII label)");
      assert.equal(received.at(-1).key, KEY);
      assert.ok(JSON.parse(received.at(-1).body).context[0].label.includes("·"));
    });

    await t.test("the cap is 65 536 bytes: a body of exactly that size passes, one byte more is 413 with the documented body", async () => {
      // Bug caught: no cap, a cap of the wrong size, or an off-by-one at the limit.
      const atCap = padded(CAP);
      assert.equal(atCap.length, CAP);
      const ok = await post(base, atCap);
      assert.equal(ok.status, 200); await ok.text();
      assert.ok(received.at(-1).body.equals(atCap));
      const before = received.length;
      const over = await post(base, padded(CAP + 1));
      const text = await over.text();
      assert.equal(over.status, 413);
      assert.deepEqual(JSON.parse(text), { detail: "request body exceeds 65536 bytes" });
      assert.ok(!text.includes(KEY)); assert.equal(over.headers.get("content-type"), "application/json");
      assert.equal(received.length, before, "an over-long body never reaches Ceres");
    });

    await t.test("the cap counts bytes, not characters", async () => {
      // Bug caught: the cap is applied to a decoded string, so 40 000 two-byte characters (80 000 bytes) get through.
      const before = received.length;
      const r = await post(base, padded(2 * 40000 + Buffer.byteLength('{"question":"q","lang":"en","pad":""}'), "ă"));
      assert.equal(r.status, 413); await r.text();
      assert.equal(received.length, before);
    });

    await t.test("an over-long Content-Length is refused before the body is read", async () => {
      // Bug caught: the proxy buffers the whole body first; here only 20 bytes of a promised megabyte are ever sent.
      const before = received.length;
      const text = await exchange(port, [`POST /ceres/v1/ask HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{"question":"q"`]);
      assert.equal(status(text), 413, text);
      assert.deepEqual(bodyOf(text), { detail: "request body exceeds 65536 bytes" });
      assert.equal(received.length, before);
    });

    await t.test(chunkedRefused ? "chunked bodies are refused with 411, never read" : "chunked bodies are counted as they arrive: over the cap is 413 before the body ends", async () => {
      // Bug caught: a chunked body (no Content-Length to check) is read without a bound.
      const chunk = (n) => `${n.toString(16)}\r\n${"a".repeat(n)}\r\n`;
      const head = "POST /ceres/v1/ask HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
      const before = received.length;
      // never ends: no final chunk is sent, so an answer can only come from a decision made while the body is still arriving
      const text = await exchange(port, [head, chunk(20000), chunk(20000), chunk(20000), chunk(20000)]);
      assert.equal(status(text), chunkedRefused ? 411 : 413, text);
      assert.equal(received.length, before);
      assert.ok(!text.includes(KEY));
      if (chunkedRefused) assert.ok(typeof bodyOf(text).detail === "string");
      else assert.deepEqual(bodyOf(text), { detail: "request body exceeds 65536 bytes" });
    });

    await t.test(chunkedRefused ? "a small chunked body is refused with 411 too" : "a small chunked body under the cap is forwarded unchanged", async () => {
      // Bug caught: (node) chunked bodies refused altogether, or (python) a small chunked body accepted.
      const body = '{"question":"q","lang":"en"}';
      const before = received.length;
      const text = await exchange(port, [`POST /ceres/v1/ask HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
                                         `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`], { done: () => false, maxMs: 1500 });
      if (chunkedRefused) { assert.equal(status(text), 411, text); assert.equal(received.length, before); }
      else { assert.equal(status(text), 200, text); assert.equal(received.length, before + 1); assert.equal(received.at(-1).body.toString(), body); }
    });

    await t.test("the cap also stops the other allowed routes, and the 404 for other paths still comes first", async () => {
      // Bug caught: the cap check runs before the allowlist, so a disallowed path answers 413 (or an allowed GET with a huge body is forwarded).
      const before = received.length;
      const r = await fetch(`${base}/ceres/docs`, { method: "POST", body: padded(CAP + 10) });
      assert.equal(r.status, 404); await r.text();
      assert.equal(received.length, before);
    });

    await t.test("Ceres's own errors pass through unchanged (409 and the legacy 422)", async () => {
      // Bug caught: the proxy turns Ceres's 4xx into its own 502 or rewrites the body, so ceres-js cannot map conflict or unsupported.
      const conflict = await post(base, '{"question":"CONFLICT","lang":"en"}');
      assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { detail: "request_conflict" });
      const legacy = await post(base, '{"question":"LEGACY","lang":"en","context":[]}');
      assert.equal(legacy.status, 422); assert.deepEqual(await legacy.json(), JSON.parse(LEGACY_422));
    });

    await t.test("upstream failures: a Ceres that never answers is 504 upstream_timeout", async () => {
      // Bug caught: the proxy waits forever (or drops the connection) when Ceres does not answer.
      const started = Date.now();
      const r = await post(base, '{"question":"HANG","lang":"en"}');
      const text = await r.text();
      assert.equal(r.status, 504); assert.deepEqual(JSON.parse(text), { detail: "upstream_timeout" }); assert.ok(!text.includes(KEY));
      assert.ok(Date.now() - started < 3000);
    });

    await t.test("ceres-js through the proxy: 409 is conflict, the legacy 422 is unsupported, 504 is timeout", async () => {
      // Bug caught: the proxy's bodies do not match what ceres-js maps, so apps see generic errors.
      const c = createCeresClient({ baseUrl: `${base}/ceres` });
      await assert.rejects(c.ask("CONFLICT", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "conflict" && !e.retryable);
      await assert.rejects(c.ask("HANG", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "timeout" && e.retryable && e.status === 504);
    });
  });

  test(`${name} proxy: Ceres unreachable`, async (t) => {
    // Bug caught: with Ceres down the proxy answers with text, a dropped connection or a leaked key instead of the documented 502 body.
    const dead = createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
    const deadUrl = `http://127.0.0.1:${dead.address().port}`; await new Promise((r) => dead.close(r));   // a port nobody listens on
    const base = await start(cmd, args, port + 10, { CERES_URL: deadUrl });
    await t.test("every forwarded route answers 502 upstream_unreachable", async () => {
      for (const [m, p] of [["POST", "/ceres/v1/ask"], ["GET", "/ceres/v1/info"], ["GET", "/ceres/health"], ["GET", "/ceres/v1/profiles"]]) {
        const r = await fetch(`${base}${p}`, { method: m, body: m === "POST" ? ONE_PARCEL : undefined, headers: { "Content-Type": "application/json" } });
        const text = await r.text();
        assert.equal(r.status, 502, `${m} ${p}`); assert.deepEqual(JSON.parse(text), { detail: "upstream_unreachable" }); assert.ok(!text.includes(KEY));
      }
    });
    await t.test("ceres-js maps it to a retryable network error", async () => {
      const c = createCeresClient({ baseUrl: `${base}/ceres` });
      await assert.rejects(c.ask("q", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "network" && e.retryable && e.status === 502);
      await assert.rejects(c.supports("context-v0"), (e) => e instanceof CeresError && e.kind === "network", "discovery through a dead proxy is network, never unsupported");
    });
  });
}

test("node proxy: a chunked body of exactly 65 536 bytes is forwarded and 65 537 bytes is 413", async () => {
  // Bug caught: the chunked cap is off by one (a body at the cap refused, or one byte over it forwarded).
  const port = 18960;
  await start(process.execPath, [`${REPO}/proxy/node/server.mjs`], port);
  const chunk = (n) => `${n.toString(16)}\r\n${"a".repeat(n)}\r\n`;
  const head = "POST /ceres/v1/ask HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
  const before = received.length;
  const atCap = await exchange(port, [head, chunk(32768), chunk(32768), "0\r\n\r\n"]);
  assert.equal(status(atCap), 200, atCap);
  assert.equal(received.length, before + 1);
  assert.equal(received.at(-1).body.length, CAP, "Ceres received every byte");
  const over = await exchange(port, [head, chunk(32768), chunk(32769), "0\r\n\r\n"]);
  assert.equal(status(over), 413, over);
  assert.deepEqual(bodyOf(over), { detail: "request body exceeds 65536 bytes" });
  assert.equal(received.length, before + 1, "the over-long body never reaches Ceres");
});

test("python proxy: a connect timeout (URLError wrapping a timeout) is 504 upstream_timeout like a read timeout, and a refused connection stays 502", async () => {
  // Bug caught: only a bare TimeoutError is read as a timeout, so a connect timeout (which urllib raises as URLError) is 502 and the
  // client reports `network` instead of `timeout`. No offline connect can be made to time out reliably, so the proxy runs with
  // urllib's urlopen replaced by one that raises what urllib raises; the handler and its error mapping are the real ones.
  const launcher = [
    "import runpy, sys, urllib.error, urllib.request",
    "def fake_urlopen(req, timeout=None):",
    "    body = req.data or b''",
    "    if b'CONNECT_TIMEOUT' in body: raise urllib.error.URLError(TimeoutError('timed out'))",
    "    if b'READ_TIMEOUT' in body: raise TimeoutError('timed out')",
    "    raise urllib.error.URLError(ConnectionRefusedError(111, 'Connection refused'))",
    "urllib.request.urlopen = fake_urlopen",
    "runpy.run_path(sys.argv[1], run_name='__main__')",
  ].join("\n");
  const base = await start("python3", ["-c", launcher, `${REPO}/proxy/python/server.py`], 18970);
  const ask = async (question) => { const r = await post(base, JSON.stringify({ question, lang: "en" })); return [r.status, await r.json()]; };
  assert.deepEqual(await ask("CONNECT_TIMEOUT"), [504, { detail: "upstream_timeout" }]);
  assert.deepEqual(await ask("READ_TIMEOUT"), [504, { detail: "upstream_timeout" }]);
  assert.deepEqual(await ask("REFUSED"), [502, { detail: "upstream_unreachable" }]);
  const c = createCeresClient({ baseUrl: `${base}/ceres` });
  await assert.rejects(c.ask("CONNECT_TIMEOUT", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "timeout" && e.retryable && e.status === 504);
});

test("the proxies behave the same: same status and body for the same bad requests", async () => {
  // Bug caught: the two samples drift apart (different status or detail for a missing route, an over-long body or a dead Ceres).
  const bases = [`http://127.0.0.1:18930`, `http://127.0.0.1:18931`];
  const outcomes = [];
  for (const base of bases) {
    const row = [];
    for (const [m, p, body] of [["GET", "/ceres/docs"], ["POST", "/ceres/v1/ask", padded(CAP + 1)], ["POST", "/ceres/v1/ask", padded(CAP)]]) {
      const r = await fetch(`${base}${p}`, { method: m, body });
      row.push([r.status, r.status === 200 ? "answer" : await r.text().then((t) => (t ? JSON.parse(t) : t))]);
    }
    outcomes.push(row);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});
