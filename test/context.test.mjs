// context-v0 in ceres-js: the golden cases in test/contract/ (generated elsewhere, never edited here) and the failures they do not cover.
// The fakes below replace fetch only; the client code under test is the real one.
//
// How the client can fail, and the test that catches each:
//   * a golden reply is normalized wrongly (kind, item, numbering, appEvidence, context)   → "exchange: …" (one per EXCHANGES.json pair)
//   * a golden file is added or changed and nothing checks it                                 → "every golden file is exercised"
//   * a valid request is altered on the wire, or an invalid one is sent                       → "request cases: …"
//   * a capability file is read wrongly (legacy, malformed features, malformed context)        → "capability cases"
//   * context is sent to a Ceres that cannot take it, or a no-context ask pays for discovery   → "support and no-context asks"
//   * the items are read after ask() returns, so later edits reach the request or the reply check → "deep copy: …"
//   * discovery gets a deadline of its own, or runs after the deadline has passed               → "discovery shares the ask's deadline"
//   * the capability cache goes stale after an old Ceres answers the legacy 422                  → "legacy 422 drops the cache"
//   * a nested 422 is taken for "no context", or 409 / 502 / 504 keep a generic kind             → "error mapping"
//   * the cache is not shared, not refreshed by info(), or kept after a malformed refresh        → "capability cache"
//   * a discovery failure is reported as `unsupported`                                           → "discovery failures keep their kinds"
//   * the discovery request goes out without the user's token                                     → "discovery sends the token"
//   * an item that breaks an item rule is sent, or a valid one refused                           → "item rules: …"
//   * values that JSON turns into something else (NaN → null) pass as numbers                    → "items must be JSON"
//   * the reply is trusted although it does not match what was sent                              → "reply checks: …"
//   * numbering restarts per kind, or an app citation is looked up among passages                → "numbering across kinds"
//   * a reply to a question without context is read as one with context, or the reverse           → "replies without submitted items"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createCeresClient, normalizeReply, CeresError, checkContextItems } from "../src/ceres-client.js";

const CONTRACT = new URL("./contract/", import.meta.url);
const fx = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, CONTRACT)));
const EXCHANGES = JSON.parse(readFileSync(new URL("EXCHANGES.json", CONTRACT)));

const BASE = "http://ceres.test";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hangUntilAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const later = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake Ceres behind fetch. `info`: a capability file name, an object or a function (call) → Response; `ask`: (call) → Response.
function fakeCeres({ info = "info-context-v0", ask = () => json(200, fx("resp-empty-context")) } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { method: init.method || "GET", path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined,
                   signal: init.signal, headers: init.headers };
    calls.push(call);
    if (call.path === "/v1/info") return typeof info === "function" ? info(call) : json(200, typeof info === "string" ? fx(info) : info);
    if (call.path === "/v1/ask") return ask(call);
    return json(404, { detail: "not found" });
  };
  f.calls = calls;
  f.gets = () => calls.filter((c) => c.method === "GET");
  f.posts = () => calls.filter((c) => c.method === "POST");
  return f;
}
const clientOn = (fetch, extra = {}) => createCeresClient({ baseUrl: BASE, fetch, ...extra });
const optsOf = (req) => ({ lang: req.lang, requestId: req.request_id, conversationId: req.conversation_id, profileId: req.profile_id, context: req.context });
const outcomeOf = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const isError = (kind) => (e) => e instanceof CeresError && e.kind === kind;

// A small valid parcel and ways to change it.
const parcel = (over = {}) => ({ type: "parcel", id: "P-1", revision: "r1", label: "Parcel 1",
  data: { crop: "maize", season: 2026, areaHa: 12.4, region: "Teleorman", sowingDate: "2026-04-18",
          indices: { ndvi: [{ date: "2026-05-01", value: 0.41 }, { date: "2026-05-11", value: 0.52 }] } }, ...over });
const withData = (patch) => { const p = parcel(); return { ...p, data: { ...p.data, ...patch } }; };
const series = (n) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), value: i / 10 }));
const infoWith = (limits, extra = {}) => { const i = fx("info-context-v0"); i.context.limits = { ...i.context.limits, ...limits }; return { ...i, ...extra }; };

// ---------------------------------------------------------------------------------------------------------------------------------
// The golden exchanges: every pair in EXCHANGES.json is driven through the client with a fake fetch. The request is built from the
// request file, the posted body must equal that file, and the answer is the response file.

async function run(ex, { prime = false } = {}) {
  const req = fx(ex.request), resp = fx(ex.response);
  const fake = fakeCeres({ info: ex.info, ask: (call) => (ex.after && fake.posts().length === 1 ? json(200, fx("resp-mixed")) : json(ex.status, resp)) });
  const client = clientOn(fake);
  if (prime) assert.equal(await client.supports("context-v0"), true);
  if (ex.after) await client.ask(fx(ex.after).question, optsOf(fx(ex.after)));
  const { value, error } = await outcomeOf(client.ask(req.question, optsOf(req)));
  if (fake.posts().length > 0) assert.deepEqual(fake.posts().at(-1).body, req, "the posted body is the request file");
  return { value, error, fake, req };
}
const accepted = (id, evidenceId, cited, extra = {}) => ({ type: "parcel", id, revision: "2026-05-21T09:00:00Z", status: "accepted", evidenceId, cited, ignored: [], reason: null, ...extra });
const P1042 = { type: "parcel", id: "P-1042", revision: "2026-05-21T09:00:00Z", label: "Parcel 1042 · Ferma Dealu" };
const mustBeBadResponse = ({ value, error }) => { assert.equal(value, undefined); assert.ok(isError("bad_response")(error), String(error)); };

const EXPECT = {
  "resp-mixed": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined);
    assert.equal(r.decision, "PARTIAL");
    assert.deepEqual(r.citations.map((c) => [c.number, c.kind, c.evidenceId]), [[1, "app", "D1"], [2, "library", "E1"]]);
    assert.deepEqual(r.citations[0].item, P1042); assert.equal(r.citations[0].passage, null);
    assert.equal(r.citations[1].item, null); assert.equal(r.citations[1].passage.evidenceId, "E1");
    assert.equal(r.appEvidence.length, 1);
    const d1 = r.appEvidence[0];
    assert.deepEqual([d1.evidenceId, d1.cited, d1.citationNumber, d1.renderer], ["D1", true, 1, "parcel-text-v1"]);
    assert.deepEqual(d1.item, P1042); assert.match(d1.text, /NDVI on 2026-05-21: 0\.58/); assert.match(d1.textSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.context, [accepted("P-1042", "D1", true)]);
    assert.deepEqual(r.passages.map((p) => [p.evidenceId, p.cited, p.citationNumber]).slice(0, 2), [["E1", true, 2], ["E2", false, null]]);
  },
  "resp-accepted-uncited": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined);
    assert.equal(r.decision, "ANSWER");
    assert.deepEqual(r.appEvidence.map((e) => [e.evidenceId, e.cited, e.citationNumber]), [["D1", false, null]]);
    assert.deepEqual(r.context, [accepted("P-1042", "D1", false)]);
    assert.deepEqual(r.citations.map((c) => [c.number, c.kind]), [[1, "library"]]);
  },
  "resp-unknown-keys": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined);
    assert.deepEqual(r.context[0].ignored, ["/data/irrigationPlan", "/data/indices/lai"]);   // the outermost unknown keys only
    assert.deepEqual(r.appEvidence.map((e) => e.cited), [false]);
  },
  "resp-not-used": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined);
    assert.deepEqual(r.context, [accepted("P-1042", "D1", false), { type: "parcel", id: "P-0877", revision: "2026-05-21T09:00:00Z", status: "not_used",
                                                                   evidenceId: null, cited: false, ignored: [], reason: "packet_full" }]);
    assert.deepEqual(r.appEvidence.map((e) => e.evidenceId), ["D1"], "a not_used item has no app evidence entry");
  },
  "resp-clarify": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined, "a CLARIFY is a reply, not an error");
    assert.equal(r.decision, "CLARIFY"); assert.equal(r.answered, false); assert.equal(r.reasonCode, "MISSING_USER_OR_PARCEL_INFORMATION");
    assert.ok(r.answer.length > 0); assert.deepEqual(r.citations, []);
    assert.deepEqual(r.context.map((c) => [c.id, c.status, c.evidenceId]), [["P-1042", "accepted", "D1"], ["P-0877", "accepted", "D2"]]);
  },
  "resp-empty-context": async (ex) => {
    const { value: r, error, fake } = await run(ex); assert.equal(error, undefined);
    assert.deepEqual(fake.posts()[0].body.context, [], "context: [] is sent as []");
    assert.deepEqual(r.context, []); assert.deepEqual(r.appEvidence, []); assert.equal(r.decision, "ANSWER");
  },
  "resp-structure-failed": async (ex) => {
    const { value: r, error } = await run(ex); assert.equal(error, undefined);
    assert.equal(r.decision, "NO_ANSWER"); assert.equal(r.answered, false); assert.equal(r.meta.state, "STRUCTURE_FAILED");
    assert.deepEqual(r.citations, []);
    assert.deepEqual(r.context, [accepted("P-1042", "D1", false)]);
    assert.deepEqual(r.appEvidence.map((e) => [e.evidenceId, e.cited]), [["D1", false]]);
  },
  "resp-bad-ack-missing": async (ex) => mustBeBadResponse(await run(ex)),
  "resp-bad-ack-revision": async (ex) => mustBeBadResponse(await run(ex)),
  "resp-bad-evidence-item": async (ex) => mustBeBadResponse(await run(ex)),
  "resp-bad-dangling": async (ex) => mustBeBadResponse(await run(ex)),
  "resp-bad-kind": async (ex) => mustBeBadResponse(await run(ex)),
  "resp-legacy": async (ex) => {
    const { value: r, error, fake } = await run(ex); assert.equal(error, undefined);
    assert.equal("context" in fake.posts()[0].body, false, "no context field without the option");
    assert.deepEqual(fake.gets(), [], "an ask without context does not ask what Ceres supports");
    assert.deepEqual(r.citations.map((c) => [c.kind, c.item, c.passage?.evidenceId]), [["library", null, "E2"]]);
    assert.deepEqual(r.appEvidence, []); assert.equal(r.context, null);
  },
  "err-422-legacy-context": async (ex) => {
    const { value, error, fake } = await run(ex, { prime: true });
    assert.equal(value, undefined); assert.ok(isError("unsupported")(error)); assert.equal(error.status, 422); assert.equal(error.retryable, false);
    assert.equal(fake.posts().length, 1, "no retry, with or without the context");
    assert.equal(fake.gets().length, 1, "the capability cache was filled once, from the priming call");
  },
  "err-422-context-invalid": async (ex) => {
    // ceres-js refuses this request itself, so the 422 is also shown arriving for a request ceres-js does send.
    const refused = await run(ex);
    assert.ok(isError("bad_request")(refused.error)); assert.deepEqual(refused.fake.posts(), [], "refused before any POST /v1/ask");
    const fake = fakeCeres({ ask: () => json(422, fx(ex.response)) });
    const { error } = await outcomeOf(clientOn(fake).ask("q", { lang: "en", context: [parcel()] }));
    assert.ok(isError("bad_request")(error) && error.status === 422, "a nested loc is never the legacy case"); assert.equal(error.retryable, false);
  },
  "err-409-request-conflict": async (ex) => {
    const { value, error, fake } = await run(ex);
    assert.equal(value, undefined); assert.ok(isError("conflict")(error)); assert.equal(error.status, 409); assert.equal(error.retryable, false);
    assert.equal(error.detail, "request_conflict"); assert.equal(fake.posts().length, 2);
  },
  "err-409-revision-conflict": async (ex) => {
    const { value, error } = await run(ex);
    assert.equal(value, undefined); assert.ok(isError("conflict")(error)); assert.equal(error.status, 409); assert.equal(error.detail, "revision_conflict");
  },
};

for (const ex of EXCHANGES) {
  test(`exchange: ${ex.response} (${ex.request}, ${ex.info})`, async () => {
    assert.ok(EXPECT[ex.response], `no expectation written for ${ex.response}`);
    await EXPECT[ex.response](ex);
  });
}

test("every golden file is exercised: each EXCHANGES.json pair has an expectation, and no file is left out", () => {
  // Bug caught: a new or renamed golden case that no test looks at.
  assert.deepEqual(Object.keys(EXPECT).sort(), EXCHANGES.map((e) => e.response).sort());
  const exercised = new Set(["INDEX.md", "EXCHANGES.json", "err-413.json"]);
  for (const e of EXCHANGES) for (const n of [e.response, e.request, e.info, e.after]) if (n) exercised.add(`${n}.json`);
  for (const n of [...REQ_VALID, ...Object.keys(REQ_BAD), ...INFO_CASES]) exercised.add(`${n}.json`);
  assert.deepEqual(readdirSync(CONTRACT).filter((f) => !exercised.has(f)), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests and capability files that have no reply of their own.

const REQ_VALID = ["req-one-parcel", "req-two-parcels", "req-two-parcels-full", "req-empty-context", "req-unknown-keys", "req-extra-keys-at-limit",
                   "req-replay-first", "req-revision-first"];
const REQ_BAD = { "req-bad-unsorted-series": "series dates must be strictly increasing", "req-bad-string-number": "no type coercion",
                  "req-bad-duplicate-item": "one item per (type, id)", "req-bad-extra-keys-over": "51 unknown keys > max_extra_keys" };
const INFO_CASES = ["info-context-v0", "info-legacy", "info-malformed-features", "info-malformed-context"];

test("request cases: a valid request reaches the wire exactly as the file says (nothing added, dropped or reordered in value)", async () => {
  // Bug caught: the client rewrites, trims or drops part of a valid item, or refuses a valid one (unknown keys at the limit).
  for (const name of REQ_VALID) {
    const req = fx(name);
    const fake = fakeCeres();
    await clientOn(fake).ask(req.question, optsOf(req)).catch(() => {});   // the reply is not the point here
    assert.equal(fake.posts().length, 1, `${name} was sent`);
    assert.deepEqual(fake.posts()[0].body, req, name);
  }
});

test("request cases: an invalid request is refused as bad_request before any POST /v1/ask", async () => {
  // Bug caught: unsorted series, a string for a number, a duplicate item or too many unknown keys reach Ceres.
  for (const [name, why] of Object.entries(REQ_BAD)) {
    const req = fx(name);
    const fake = fakeCeres();
    await assert.rejects(clientOn(fake).ask(req.question, optsOf(req)), isError("bad_request"), `${name}: ${why}`);
    assert.deepEqual(fake.posts(), [], name);
  }
});

test("request cases: 50 unknown keys pass and 51 fail only because of the advertised limit", async () => {
  // Bug caught: the unknown-key count is off by one, or the limit is hard-coded instead of read from /v1/info.
  const req = fx("req-extra-keys-at-limit");
  const strict = fakeCeres({ info: infoWith({ max_extra_keys: 49 }) });
  await assert.rejects(clientOn(strict).ask(req.question, optsOf(req)), isError("bad_request"));
  const roomy = fakeCeres({ info: infoWith({ max_extra_keys: 51 }) });
  const over = fx("req-bad-extra-keys-over");
  await clientOn(roomy).ask(over.question, optsOf(over)).catch(() => {});
  assert.equal(roomy.posts().length, 1);
});

test("capability cases: info-context-v0 is supported, info-legacy is not, both malformed files are bad_response", async () => {
  // Bug caught: features missing is read as malformed (or malformed as legacy), or a half-described context is trusted.
  assert.equal(await clientOn(fakeCeres({ info: "info-context-v0" })).supports("context-v0"), true);
  assert.equal(await clientOn(fakeCeres({ info: "info-legacy" })).supports("context-v0"), false);
  assert.equal(await clientOn(fakeCeres({ info: "info-context-v0" })).supports("something-else"), false);
  for (const name of ["info-malformed-features", "info-malformed-context"]) {
    await assert.rejects(clientOn(fakeCeres({ info: name })).supports("context-v0"), isError("bad_response"), name);
    await assert.rejects(clientOn(fakeCeres({ info: name })).refreshCapabilities(), isError("bad_response"), name);
    await assert.rejects(clientOn(fakeCeres({ info: name })).info(), isError("bad_response"), name);
    const fake = fakeCeres({ info: name });
    await assert.rejects(clientOn(fake).ask("q", { lang: "en", context: [parcel()] }), isError("bad_response"), name);
    assert.deepEqual(fake.posts(), [], `${name}: nothing was sent`);
  }
});

test("capability cases: every required capability field is checked", async () => {
  // Bug caught: a missing or non-integer limit, or a non-string in types/indices/features, is accepted.
  const broken = [
    ["no context object", { ...fx("info-context-v0"), context: undefined }],
    ["context not an object", { ...fx("info-context-v0"), context: [] }],
    ["types missing", (() => { const i = fx("info-context-v0"); delete i.context.types; return i; })()],
    ["types with a number", (() => { const i = fx("info-context-v0"); i.context.types = ["parcel", 1]; return i; })()],
    ["indices not a list", (() => { const i = fx("info-context-v0"); i.context.indices = "ndvi"; return i; })()],
    ["limits missing", (() => { const i = fx("info-context-v0"); delete i.context.limits; return i; })()],
    ...["max_items", "max_series", "max_points", "max_extra_keys", "max_extra_string_chars"].flatMap((k) => [
      [`${k} missing`, (() => { const i = fx("info-context-v0"); delete i.context.limits[k]; return i; })()],
      [`${k} zero`, infoWith({ [k]: 0 })], [`${k} negative`, infoWith({ [k]: -3 })], [`${k} a string`, infoWith({ [k]: "5" })],
      [`${k} a fraction`, infoWith({ [k]: 2.5 })], [`${k} null`, infoWith({ [k]: null })]]),
    ["features a string", { ...fx("info-legacy"), features: "context-v0" }],
    ["features with a non-string", { ...fx("info-legacy"), features: ["context-v0", 3] }],
    ["info not an object", [1, 2]],
  ];
  for (const [name, info] of broken) await assert.rejects(clientOn(fakeCeres({ info })).supports("context-v0"), isError("bad_response"), name);
  // Other features, with no context, need no context object.
  assert.equal(await clientOn(fakeCeres({ info: { ...fx("info-legacy"), features: ["other"] } })).supports("context-v0"), false);
});

test("capability cases: err-413 is too_long and not retryable", async () => {
  const fake = fakeCeres({ ask: () => json(413, fx("err-413")) });
  await assert.rejects(clientOn(fake).ask("q", { lang: "en" }), (e) => isError("too_long")(e) && e.status === 413 && !e.retryable);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// support, the option and the no-context path

test("support and no-context asks: context needs context-v0 (also []), and a legacy Ceres still takes questions without it", async () => {
  // Bug caught: context is posted to an old Ceres, or every ask pays for a discovery, or an ask without the option stops working.
  for (const context of [[parcel()], []]) {
    const fake = fakeCeres({ info: "info-legacy" });
    await assert.rejects(clientOn(fake).ask("q", { lang: "en", context }), (e) => isError("unsupported")(e) && !e.retryable);
    assert.deepEqual(fake.posts(), [], "unsupported before any POST /v1/ask");
    assert.equal(fake.gets().length, 1, "the discovery GET may run");
  }
  const fake = fakeCeres({ info: "info-legacy", ask: () => json(200, fx("resp-legacy")) });
  const c = clientOn(fake);
  await c.ask("q", { lang: "en" }); await c.ask("q", { lang: "en", context: undefined });
  assert.equal(fake.gets().length, 0); assert.equal(fake.posts().length, 2);
  for (const p of fake.posts()) assert.equal("context" in p.body, false, "an absent or undefined option omits the field");
});

test("support and no-context asks: null and non-arrays are refused locally", async () => {
  // Bug caught: `null` is sent as "no context" or an object is sent as the context.
  for (const context of [null, {}, "P-1", 0, parcel()]) {
    const fake = fakeCeres();
    await assert.rejects(clientOn(fake).ask("q", { lang: "en", context }), isError("bad_request"), JSON.stringify(context));
    assert.deepEqual(fake.calls, []);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the snapshot, the deadline and the cache

test("deep copy: items changed after ask() returns its promise reach neither the request nor the reply check", async () => {
  // Bug caught: the request or the acknowledgement check reads the caller's objects after discovery has awaited.
  const items = structuredClone(fx("req-one-parcel").context);
  let release; const gate = new Promise((r) => { release = r; });
  const fake = fakeCeres({ info: async () => { await gate; return json(200, fx("info-context-v0")); }, ask: () => json(200, fx("resp-mixed")) });
  const p = clientOn(fake).ask("q", { lang: "en", context: items });
  items[0].label = "Changed after the call"; items[0].data.crop = "wheat"; items[0].data.indices.ndvi.push({ date: "2026-06-01", value: 0.9 });
  items.push(parcel({ id: "P-2" }));
  release();
  const reply = await p;
  assert.deepEqual(fake.posts()[0].body.context, fx("req-one-parcel").context);
  assert.deepEqual(reply.context.map((c) => c.id), ["P-1042"]);
});

test("discovery shares the ask's deadline: discovery plus the question may not take longer than timeoutMs", async () => {
  // Bug caught: the discovery GET and the POST each get their own timeoutMs, so an ask can take twice as long.
  const fake = fakeCeres({ info: async (call) => { await Promise.race([later(300), hangUntilAbort(call.signal)]); return json(200, fx("info-context-v0")); },
                           ask: (call) => hangUntilAbort(call.signal) });
  const started = Date.now();
  await assert.rejects(clientOn(fake, { timeoutMs: 500 }).ask("q", { lang: "en", context: [parcel()] }), isError("timeout"));
  const took = Date.now() - started;
  assert.equal(fake.gets().length, 1, "the discovery ran inside this ask");
  assert.equal(fake.posts().length, 1, "the discovery finished in time, so the question was sent");
  assert.ok(took >= 450 && took < 700, `took ${took} ms for a 500 ms deadline`);
});

test("discovery shares the ask's deadline: a timeout or an abort during discovery sends no question", async () => {
  // Bug caught: the question is posted after the deadline passed or the caller gave up while discovery was running.
  const slow = () => fakeCeres({ info: (call) => hangUntilAbort(call.signal) });
  const a = slow();
  await assert.rejects(clientOn(a, { timeoutMs: 40 }).ask("q", { lang: "en", context: [parcel()] }), isError("timeout"));
  assert.deepEqual(a.posts(), []);
  const b = slow(); const ctl = new AbortController();
  const p = clientOn(b).ask("q", { lang: "en", context: [parcel()], signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, isError("aborted")); assert.deepEqual(b.posts(), []);
  const c = slow(); const done = new AbortController(); done.abort();
  await assert.rejects(clientOn(c).ask("q", { lang: "en", context: [parcel()], signal: done.signal }), isError("aborted"));
  assert.deepEqual(c.calls, [], "an already-aborted signal sends nothing at all");
});

test("discovery shares the ask's deadline: a discovery that ignores the signal still stops at the deadline", async () => {
  // Bug caught: discovery is awaited outside the deadline guard, so a fetch that never settles hangs the ask forever.
  const fake = fakeCeres({ info: () => new Promise(() => {}) });
  await assert.rejects(clientOn(fake, { timeoutMs: 30 }).ask("q", { lang: "en", context: [parcel()] }), isError("timeout"));
});

test("legacy 422 drops the cache: the next context ask asks Ceres again, and nothing is retried", async () => {
  // Bug caught: after an old Ceres refuses `context`, the client keeps believing context-v0 is supported (or retries without context).
  let ceresIsNew = true;
  const fake = fakeCeres({ info: () => json(200, fx(ceresIsNew ? "info-context-v0" : "info-legacy")),
                           ask: () => json(422, fx("err-422-legacy-context")) });
  const c = clientOn(fake);
  assert.equal(await c.supports("context-v0"), true);
  ceresIsNew = false;                                    // Ceres was replaced by an old one behind the client's back
  await assert.rejects(c.ask("q", { lang: "en", context: [parcel()] }), isError("unsupported"));
  assert.equal(fake.posts().length, 1, "no retry");
  assert.equal(await c.supports("context-v0"), false, "the cache was dropped and refilled from the old Ceres");
  assert.equal(fake.gets().length, 2);
  await assert.rejects(c.ask("q", { lang: "en", context: [parcel()] }), isError("unsupported"));
  assert.equal(fake.posts().length, 1, "now refused locally");
});

test("legacy 422 drops the cache: a discovery that was already running cannot refill it with the old answer", async () => {
  // Bug caught: a slow discovery that started before the drop writes its stale result into the cache afterwards.
  let release; const gate = new Promise((r) => { release = r; });
  let infoCalls = 0;
  const fake = fakeCeres({ info: async () => { infoCalls++; if (infoCalls === 2) await gate; return json(200, fx("info-context-v0")); },
                           ask: () => json(422, fx("err-422-legacy-context")) });
  const c = clientOn(fake);
  await c.supports("context-v0");                                            // fills the cache (call 1)
  const refreshing = c.refreshCapabilities();                               // call 2 starts, then waits
  await later(5);
  await assert.rejects(c.ask("q", { lang: "en", context: [parcel()] }), isError("unsupported"));   // drops the cache
  release(); await refreshing;
  await c.supports("context-v0");
  assert.equal(infoCalls, 3, "the stale discovery did not refill the cache, so supports() asked Ceres again");
});

test("error mapping: 409 is conflict, the pass-through details are network and timeout, other 502/504 stay server_error", async () => {
  // Bug caught: 409 falls into bad_request, a pass-through's 502/504 are generic server errors (and the retry advice is lost).
  const cases = [[409, { detail: "request_conflict" }, "conflict", false], [409, { detail: "revision_conflict" }, "conflict", false],
                 [502, { detail: "upstream_unreachable" }, "network", true], [504, { detail: "upstream_timeout" }, "timeout", true],
                 [502, { detail: "Bad Gateway" }, "server_error", true], [504, { detail: "upstream_unreachable" }, "server_error", true],
                 [502, { detail: "upstream_timeout" }, "server_error", true], [502, "<html>nginx</html>", "server_error", true],
                 [500, { detail: "upstream_timeout" }, "server_error", true]];
  for (const [status, body, kind, retryable] of cases) {
    const fake = fakeCeres({ ask: () => json(status, body) });
    await assert.rejects(clientOn(fake).ask("q", { lang: "en" }), (e) => isError(kind)(e) && e.status === status && e.retryable === retryable, `${status} ${JSON.stringify(body)}`);
  }
});

test("error mapping: only a 422 with extra_forbidden at exactly [body, context] is the legacy case", async () => {
  // Bug caught: any 422 that mentions context, or any extra_forbidden, is taken for "this Ceres has no context".
  const entry = (over) => ({ detail: [{ type: "extra_forbidden", loc: ["body", "context"], msg: "x", ...over }] });
  const cases = [[entry({}), "unsupported"], [{ detail: [{ type: "value_error", loc: ["body", "x"] }, ...entry({}).detail] }, "unsupported"],
                 [entry({ loc: ["body", "context", 0, "data"] }), "bad_request"], [entry({ loc: ["body", "other"] }), "bad_request"],
                 [entry({ type: "context_invalid" }), "bad_request"], [entry({ loc: ["body"] }), "bad_request"],
                 [{ detail: "extra_forbidden" }, "bad_request"], [{ detail: [] }, "bad_request"], [{ detail: [null, 3] }, "bad_request"]];
  for (const [body, kind] of cases) {
    const fake = fakeCeres({ ask: () => json(422, body) });
    await assert.rejects(clientOn(fake).ask("q", { lang: "en", context: [parcel()] }), isError(kind), JSON.stringify(body));
  }
});

test("error mapping: a nested 422 keeps the capability cache", async () => {
  // Bug caught: every 422 clears the cache, so each context ask after a validation error pays for a discovery.
  const fake = fakeCeres({ ask: () => json(422, fx("err-422-context-invalid")) });
  const c = clientOn(fake);
  for (let i = 0; i < 2; i++) await assert.rejects(c.ask("q", { lang: "en", context: [parcel()] }), isError("bad_request"));
  assert.equal(fake.gets().length, 1);
});

test("capability cache: supports() asks once, refreshCapabilities() asks again, info() refreshes the cache", async () => {
  // Bug caught: the cache is never used, never refreshed, or info() leaves it stale.
  let current = "info-legacy";
  const fake = fakeCeres({ info: () => json(200, fx(current)) });
  const c = clientOn(fake);
  assert.equal(await c.supports("context-v0"), false); assert.equal(await c.supports("context-v0"), false);
  assert.equal(fake.gets().length, 1);
  current = "info-context-v0";
  assert.equal(await c.supports("context-v0"), false, "still the cached answer");
  const caps = await c.refreshCapabilities();
  assert.equal(fake.gets().length, 2); assert.deepEqual(caps.features, ["context-v0"]); assert.equal(caps.context.limits.max_items, 5);
  caps.features.push("x"); caps.context.limits.max_items = 99;
  assert.equal(await c.supports("x"), false, "the returned object is a copy of the cache");
  current = "info-legacy";
  const body = await c.info();
  assert.equal(body.route_status, "assigned", "info() still returns the /v1/info body");
  assert.equal(await c.supports("context-v0"), false, "info() refreshed the cache");
  assert.equal(fake.gets().length, 3);
});

test("capability cache: a malformed refresh drops what the cache held, and a failed discovery is not cached", async () => {
  // Bug caught: after a malformed /v1/info the old "supported" answer is still used, or an error is cached as an answer.
  let current = "info-context-v0";
  const fake = fakeCeres({ info: () => (current === "down" ? json(503, { detail: "starting" }) : json(200, fx(current))) });
  const c = clientOn(fake);
  assert.equal(await c.supports("context-v0"), true);
  current = "info-malformed-context";
  await assert.rejects(c.refreshCapabilities(), isError("bad_response"));
  current = "info-context-v0";
  assert.equal(await c.supports("context-v0"), true); assert.equal(fake.gets().length, 3, "the cache was empty, so Ceres was asked again");
  current = "down";
  await assert.rejects(c.refreshCapabilities(), isError("not_ready"));
  assert.equal(await c.supports("context-v0"), true, "a refresh that could not reach Ceres keeps what was known");
  const fresh = clientOn(fake);
  await assert.rejects(fresh.supports("context-v0"), isError("not_ready"));
  current = "info-context-v0";
  assert.equal(await fresh.supports("context-v0"), true);
});

test("capability cache: supports() obeys its signal", async () => {
  // Bug caught: the discovery behind supports() cannot be cancelled.
  const fake = fakeCeres({ info: (call) => hangUntilAbort(call.signal) });
  const ctl = new AbortController();
  const p = clientOn(fake).supports("context-v0", { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, isError("aborted"));
});

test("discovery failures keep their kinds: an unreachable Ceres is never `unsupported`", async () => {
  // Bug caught: a failed GET /v1/info is read as "no context-v0", so a user is told the feature does not exist when Ceres is only down.
  const cases = [[() => json(503, { detail: "warming up" }), "not_ready"], [() => json(401, { detail: "key" }), "unauthorized"],
                 [() => json(502, { detail: "upstream_unreachable" }), "network"], [() => json(504, { detail: "upstream_timeout" }), "timeout"],
                 [() => { throw new TypeError("fetch failed"); }, "network"], [() => json(500, { detail: "boom" }), "server_error"],
                 [() => new Response("<html>login</html>", { status: 200 }), "bad_response"]];
  for (const [info, kind] of cases) {
    const fake = fakeCeres({ info });
    await assert.rejects(clientOn(fake).ask("q", { lang: "en", context: [parcel()] }), isError(kind), kind);
    assert.deepEqual(fake.posts(), []);
    await assert.rejects(clientOn(fakeCeres({ info })).supports("context-v0"), isError(kind), kind);
  }
});

test("discovery sends the token: the GET /v1/info carries the user's Authorization like every other request", async () => {
  // Bug caught: discovery bypasses getToken, so it is refused (or unauthenticated) behind a backend that requires a login.
  const fake = fakeCeres({ ask: () => json(200, fx("resp-empty-context")) });
  await clientOn(fake, { getToken: async () => "tok-1", headers: { "X-App": "veridian" } }).ask("q", { lang: "en", context: [] });
  assert.equal(fake.gets()[0].headers.Authorization, "Bearer tok-1"); assert.equal(fake.gets()[0].headers["X-App"], "veridian");
  assert.equal(fake.posts()[0].headers.Authorization, "Bearer tok-1");
  const failing = fakeCeres();
  await assert.rejects(clientOn(failing, { getToken: async () => { throw new Error("expired"); } }).ask("q", { lang: "en", context: [] }), isError("unauthorized"));
  assert.deepEqual(failing.calls, [], "no discovery without a token either");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the item rules, as client-side checks

async function refusedAs(items, why, info) {
  const fake = fakeCeres({ info });
  await assert.rejects(clientOn(fake).ask("q", { lang: "en", context: items }), isError("bad_request"), why);
  assert.deepEqual(fake.posts(), [], `${why}: nothing sent`);
}
async function accepts(items, why, info) {
  const fake = fakeCeres({ info });
  await clientOn(fake).ask("q", { lang: "en", context: items }).catch((e) => { if (!isError("bad_response")(e)) throw e; });
  assert.equal(fake.posts().length, 1, `${why}: sent`);
  assert.deepEqual(fake.posts()[0].body.context, items, why);
}

test("item rules: item fields (exactly five keys, type, id, revision, label)", async () => {
  // Bug caught: an extra or missing item key, a wrong type, or a malformed id, revision or label is sent.
  const bad = {
    "item is null": [null], "item is an array": [[]], "extra item key": [{ ...parcel(), note: "x" }],
    "no label": [(() => { const p = parcel(); delete p.label; return p; })()], "no data": [(() => { const p = parcel(); delete p.data; return p; })()],
    "no id": [(() => { const p = parcel(); delete p.id; return p; })()], "type plot": [parcel({ type: "plot" })], "type missing": [(() => { const p = parcel(); delete p.type; return p; })()],
    "id empty": [parcel({ id: "" })], "id 65 chars": [parcel({ id: "a".repeat(65) })], "id with a space": [parcel({ id: "P 1" })],
    "id with a slash": [parcel({ id: "P/1" })], "id not a string": [parcel({ id: 1042 })], "id non-ASCII": [parcel({ id: "Pă" })],
    "revision empty": [parcel({ revision: "" })], "revision 65 chars": [parcel({ revision: "r".repeat(65) })], "revision with a space": [parcel({ revision: "a b" })],
    "revision non-ASCII": [parcel({ revision: "révision" })], "revision with a tab": [parcel({ revision: "a\tb" })], "revision not a string": [parcel({ revision: 3 })],
    "label empty": [parcel({ label: "" })], "label 121 characters": [parcel({ label: "a".repeat(121) })], "label 121 code points": [parcel({ label: "😀".repeat(121) })],
    "label with BEL": [parcel({ label: "a\u0007b" })], "label with DEL": [parcel({ label: "a\u007fb" })], "label with newline": [parcel({ label: "a\nb" })],
    "label not a string": [parcel({ label: 5 })], "data null": [parcel({ data: null })], "data an array": [parcel({ data: [] })], "data a string": [parcel({ data: "x" })],
    "duplicate (type, id)": [parcel(), parcel()], "duplicate id, other revision": [parcel(), parcel({ revision: "r2" })],
  };
  for (const [why, items] of Object.entries(bad)) await refusedAs(items, why);
  await accepts([parcel({ id: "A-z0.9_:-".padEnd(64, "x"), revision: "!~".padEnd(64, "#"), label: "😀".repeat(120) })], "ids, revisions and labels at their limits");
  await accepts([parcel({ label: "Parcel 1042 · Ferma Dealu — ăâîșț\u0085" })], "non-ASCII text and a C1 character are text");
});

test("item rules: the known keys of a parcel's data", async () => {
  // Bug caught: coercion (strings and booleans as numbers), null for a known key, impossible dates, or limits off by one.
  const bad = {
    "areaHa a string": withData({ areaHa: "12.4" }), "areaHa true": withData({ areaHa: true }), "areaHa zero": withData({ areaHa: 0 }),
    "areaHa negative": withData({ areaHa: -1 }), "areaHa NaN": withData({ areaHa: NaN }), "areaHa Infinity": withData({ areaHa: Infinity }),
    "areaHa null": withData({ areaHa: null }), "crop null": withData({ crop: null }), "crop empty": withData({ crop: "" }),
    "crop 61 characters": withData({ crop: "c".repeat(61) }), "crop with a newline": withData({ crop: "a\nb" }), "crop a number": withData({ crop: 5 }),
    "region 81 characters": withData({ region: "r".repeat(81) }), "region empty": withData({ region: "" }),
    "season 2101": withData({ season: 2101 }), "season 1899": withData({ season: 1899 }), "season a fraction": withData({ season: 2026.5 }),
    "season a string": withData({ season: "2026" }), "season true": withData({ season: true }), "season null": withData({ season: null }),
    "sowingDate Feb 30": withData({ sowingDate: "2026-02-30" }), "sowingDate Feb 29 in a common year": withData({ sowingDate: "2025-02-29" }),
    "sowingDate month 13": withData({ sowingDate: "2026-13-01" }), "sowingDate day 0": withData({ sowingDate: "2026-04-00" }),
    "sowingDate without zeros": withData({ sowingDate: "2026-4-8" }), "sowingDate with a time": withData({ sowingDate: "2026-04-18T00:00:00Z" }),
    "sowingDate a number": withData({ sowingDate: 20260418 }), "harvestDate bad": withData({ harvestDate: "2026-09-31" }), "harvestDate null": withData({ harvestDate: null }),
    "indices an array": withData({ indices: [] }), "indices null": withData({ indices: null }),
    "series empty": withData({ indices: { ndvi: [] } }), "series not an array": withData({ indices: { ndvi: {} } }),
    "observation without value": withData({ indices: { ndvi: [{ date: "2026-05-01" }] } }),
    "observation without date": withData({ indices: { ndvi: [{ value: 0.4 }] } }),
    "observation with an extra key": withData({ indices: { ndvi: [{ date: "2026-05-01", value: 0.4, quality: 1 }] } }),
    "observation value a string": withData({ indices: { ndvi: [{ date: "2026-05-01", value: "0.4" }] } }),
    "observation value null": withData({ indices: { ndvi: [{ date: "2026-05-01", value: null }] } }),
    "observation value NaN": withData({ indices: { ndvi: [{ date: "2026-05-01", value: NaN }] } }),
    "observation not an object": withData({ indices: { ndvi: [["2026-05-01", 0.4]] } }),
    "observation date invalid": withData({ indices: { ndvi: [{ date: "2026-02-30", value: 0.4 }] } }),
    "dates unsorted": withData({ indices: { ndvi: [{ date: "2026-05-11", value: 1 }, { date: "2026-05-01", value: 1 }] } }),
    "dates duplicated": withData({ indices: { ndvi: [{ date: "2026-05-01", value: 1 }, { date: "2026-05-01", value: 2 }] } }),
    "unknown index unsorted": withData({ indices: { lai: [{ date: "2026-05-11", value: 1 }, { date: "2026-05-01", value: 1 }] } }),
    "unknown index empty": withData({ indices: { lai: [] } }),
    "index name uppercase": withData({ indices: { NDVI: series(1) } }), "index name with a dash": withData({ indices: { "nd-vi": series(1) } }),
    "index name 33 characters": withData({ indices: { ["a".repeat(33)]: series(1) } }), "index name empty": withData({ indices: { "": series(1) } }),
  };
  for (const [why, item] of Object.entries(bad)) await refusedAs([item], why);
  await accepts([withData({ sowingDate: "2024-02-29", harvestDate: "2026-09-30", season: 1900, areaHa: 0.0001, crop: "c".repeat(60), region: "r".repeat(80),
                            indices: { ["a".repeat(32)]: series(3), ndvi_2: series(2) } })], "boundaries");
  await accepts([withData({ season: 2100 })], "season 2100");
  await accepts([{ ...parcel(), data: {} }], "an empty data object");
  await accepts([withData({ indices: {} })], "no series");
  await accepts([withData({ crop: "ñ".repeat(60) })], "crop at 60 characters counted as code points");
});

test("item rules: unknown keys are allowed inside data only, within depth, string and count limits", async () => {
  // Bug caught: unknown keys refused (or unlimited), depth counted from the wrong level, strings counted in UTF-16 units.
  const nest = (n) => { let v = {}; for (let i = 1; i < n; i++) v = { a: v }; return v; };   // n levels of objects
  await accepts([withData({ irrigationPlan: { type: "drip" }, note: null, tags: ["a", 1, true, null], lai: "x" })], "unknown keys of every JSON type");
  await accepts([withData({ deep: nest(4) })], "unknown value nested 4 levels");
  await refusedAs([withData({ deep: nest(5) })], "unknown value nested 5 levels");
  await accepts([withData({ deep: [[[[]]]] })], "four nested arrays");
  await refusedAs([withData({ deep: [[[[[]]]]] })], "five nested arrays");
  await accepts([withData({ s: "x".repeat(200), t: "😀".repeat(200) })], "unknown strings at 200 code points");
  await refusedAs([withData({ s: "x".repeat(201) })], "unknown string of 201");
  await refusedAs([withData({ list: ["ok", "x".repeat(201)] })], "unknown string of 201 inside an array");
  await refusedAs([parcel({ extra: 1 })], "unknown key at item level");
  // The count: every key of or inside an unknown value, once; an unknown index counts once and its date/value keys do not.
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  await accepts([withData({ extra: keys(49) })], "1 + 49 = 50 unknown keys");
  await refusedAs([withData({ extra: keys(50) })], "1 + 50 = 51 unknown keys");
  await accepts([withData({ ...keys(50) })], "50 unknown keys at the top of data");
  await refusedAs([withData({ ...keys(51) })], "51 unknown keys at the top of data");
  const mixedCount = (n) => withData({ a: [{ b: 1 }, { b: 2 }], ...keys(n), indices: { ndvi: series(3), lai: series(3) } });   // a, b, b, k…, lai
  await accepts([mixedCount(46)], "3 + 46 + the unknown index lai = 50");
  await refusedAs([mixedCount(47)], "3 + 47 + the unknown index lai = 51");
});

test("item rules: unknown keys are counted as the golden case says (irrigationPlan, its type and one unknown index make 3)", async () => {
  // Bug caught: the observation keys of an unknown index are counted, or the nested key of an unknown value is not.
  const req = fx("req-unknown-keys");
  const limitOf = (n) => infoWith({ max_extra_keys: n });
  await accepts(req.context, "3 unknown keys fit a limit of 3", limitOf(3));
  await refusedAs(req.context, "3 unknown keys do not fit a limit of 2", limitOf(2));
});

test("item rules: an index name is unknown when Ceres does not list it in /v1/info (an unknown index name counts as an unknown key)", async () => {
  // Bug caught: every index name counts as unknown, or none does.
  const req = fx("req-unknown-keys");
  const info = infoWith({ max_extra_keys: 2 });
  info.context.indices = ["ndvi", "lai"];
  await accepts(req.context, "lai is rendered by this Ceres, so only irrigationPlan and its type count", info);
});

test("item rules: advertised limits (items, series, points) come from /v1/info", async () => {
  // Bug caught: the limits are the defaults, or are not enforced, or are off by one.
  const info = infoWith({ max_items: 2, max_series: 2, max_points: 3 });
  await accepts([parcel({ id: "A" }), parcel({ id: "B" })], "two items", info);
  await refusedAs([parcel({ id: "A" }), parcel({ id: "B" }), parcel({ id: "C" })], "three items over max_items 2", info);
  await accepts([withData({ indices: { ndvi: series(3), evi: series(1) } })], "two series of up to 3 points", info);
  await refusedAs([withData({ indices: { ndvi: series(1), evi: series(1), lai: series(1) } })], "three series over max_series 2 (an unknown name counts)", info);
  await refusedAs([withData({ indices: { ndvi: series(4) } })], "4 points over max_points 3", info);
  await refusedAs([withData({ indices: { lai: series(4) } })], "an unknown index obeys max_points too", info);
  await refusedAs([withData({ indices: { ndvi: series(3), ndmi: series(2), lai: series(2) } })], "series are counted per item, known and unknown together", info);
  // The limits info-context-v0 advertises
  await accepts([1, 2, 3, 4, 5].map((n) => parcel({ id: `P${n}` })), "five items");
  await refusedAs([1, 2, 3, 4, 5, 6].map((n) => parcel({ id: `P${n}` })), "six items");
  await accepts([withData({ indices: { ndvi: series(200) } })], "200 points");
  await refusedAs([withData({ indices: { ndvi: series(201) } })], "201 points");
  await accepts([withData({ indices: { ndvi: series(1), evi: series(1), ndmi: series(1), ndre: series(1) } })], "four series");
  await refusedAs([withData({ indices: { ndvi: series(1), evi: series(1), ndmi: series(1), ndre: series(1), lai: series(1) } })], "five series");
});

test("item rules: a type Ceres does not announce is refused", async () => {
  // Bug caught: the advertised `types` list is ignored.
  const info = fx("info-context-v0"); info.context.types = ["selection"];
  await refusedAs([parcel()], "parcel is not announced", info);
});

test("item rules: the first failure is reported in field order, with where it is", async () => {
  // Bug caught: the message does not say which item or field broke, or a later field is reported before an earlier one.
  const fake = fakeCeres();
  const items = [parcel(), parcel({ id: "P-2", label: "", revision: "bad rev" })];
  const e = await clientOn(fake).ask("q", { lang: "en", context: items }).catch((x) => x);
  assert.ok(isError("bad_request")(e)); assert.match(e.message, /context\[1\]\.revision/);
  const e2 = await clientOn(fake).ask("q", { lang: "en", context: [withData({ indices: { ndvi: [{ date: "2026-05-02", value: 1 }, { date: "2026-05-01", value: 2 }] } })] }).catch((x) => x);
  assert.match(e2.message, /context\[0\]\.data\.indices\.ndvi\[1\]\.date/);
});

test("items must be JSON: NaN, undefined, functions, dates, cycles and other non-JSON values are refused, not turned into null", async () => {
  // Bug caught: JSON.stringify silently turns NaN into null and drops undefined, so the request is not what the caller passed.
  const cyc = { a: 1 }; cyc.self = cyc;
  const bad = { "NaN in an unknown key": withData({ x: NaN }), "Infinity in an unknown key": withData({ x: Infinity }), "undefined in an unknown key": withData({ x: undefined }),
                "function": withData({ x: () => 1 }), "Date": withData({ x: new Date() }), "Map": withData({ x: new Map() }), "bigint": withData({ x: 1n }),
                "symbol": withData({ x: Symbol("s") }), "class instance": withData({ x: new (class Foo { constructor() { this.a = 1; } })() }),
                "undefined in an array": withData({ x: [1, undefined] }), "sparse array": withData({ x: [1, , 3] }), "cycle": withData({ x: cyc }) };
  for (const [why, item] of Object.entries(bad)) await refusedAs([item], why);
  await accepts([withData({ x: null, y: { z: [null, false, 0, ""] } })], "null, false, 0 and '' are JSON");
  await accepts([JSON.parse('{"type":"parcel","id":"P","revision":"r","label":"l","data":{"__proto__":{"a":1},"crop":"maize"}}')], "a __proto__ key stays a key");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the reply (the golden files cover the common breaks; these cover the rest)

const sent = () => fx("req-one-parcel").context;
const mixed = () => structuredClone(fx("resp-mixed"));
const bad = (raw, items, why) => assert.throws(() => normalizeReply(raw, items), isError("bad_response"), why);

test("reply checks: acknowledgement entries missing, extra, duplicated or reordered are bad_response", () => {
  // Bug caught: the acknowledgement is matched by id only, so a dropped, repeated or swapped entry passes.
  const two = fx("req-two-parcels").context;
  const raw = () => structuredClone(fx("resp-clarify"));
  assert.doesNotThrow(() => normalizeReply(raw(), two));
  let r = raw(); r.meta.context.items.pop(); bad(r, two, "missing entry");
  r = raw(); r.meta.context.items.push(structuredClone(r.meta.context.items[0])); bad(r, two, "extra entry");
  r = raw(); r.meta.context.items[1] = structuredClone(r.meta.context.items[0]); bad(r, two, "duplicated entry");
  r = raw(); r.meta.context.items.reverse(); bad(r, two, "reordered");
  r = raw(); r.meta.context.items[1].id = "P-9999"; bad(r, two, "echoed id differs");
  r = raw(); r.meta.context.items[0].type = "plot"; bad(r, two, "echoed type differs");
  r = raw(); r.meta.context = []; bad(r, two, "context is not an object");
  r = raw(); r.meta.context = { items: {} }; bad(r, two, "items is not a list");
  r = raw(); r.meta.context.items[0] = null; bad(r, two, "entry is null");
  bad(raw(), [two[0]], "the reply acknowledges more items than were sent");
  bad(raw(), [...two, parcel({ id: "P-3" })], "the reply acknowledges fewer items than were sent");
  bad(raw(), [two[1], two[0]], "the items were sent in another order");
});

test("reply checks: meta.context is required even when [] was sent, and app_evidence with it", () => {
  // Bug caught: an empty submission is treated as "no context", so a missing acknowledgement passes.
  const r = structuredClone(fx("resp-empty-context"));
  assert.doesNotThrow(() => normalizeReply(r, []));
  const noAck = structuredClone(r); delete noAck.meta.context; bad(noAck, [], "no acknowledgement for []");
  const noEvidence = structuredClone(r); delete noEvidence.packet.app_evidence; bad(noEvidence, [], "no app_evidence for []");
  const extra = structuredClone(r); extra.meta.context.items.push(structuredClone(mixed().meta.context.items[0])); bad(extra, [], "an entry for nothing");
});

test("reply checks: app evidence must belong to an accepted item whose type, id, revision and label equal the submitted ones", () => {
  // Bug caught: evidence for another item, another label, or no accepted item is displayed as the user's parcel.
  const ok = () => mixed();
  for (const [why, edit] of [
    ["label differs", (r) => { r.packet.app_evidence[0].item.label = "Another parcel"; }],
    ["id differs", (r) => { r.packet.app_evidence[0].item.id = "P-2000"; }],
    ["type differs", (r) => { r.packet.app_evidence[0].item.type = "plot"; }],
    ["revision differs", (r) => { r.packet.app_evidence[0].item.revision = "other"; }],
    ["accepted entry names an unknown evidence id", (r) => { r.meta.context.items[0].evidence_id = "D2"; }],
    ["accepted entry has no evidence id", (r) => { r.meta.context.items[0].evidence_id = null; }],
    ["app evidence nobody accepted", (r) => { r.packet.app_evidence.push({ ...structuredClone(r.packet.app_evidence[0]), evidence_id: "D2" }); }],
    ["app evidence with a duplicate id", (r) => { r.packet.app_evidence.push(structuredClone(r.packet.app_evidence[0])); }],
    ["app evidence id equal to a passage id", (r) => { r.packet.app_evidence[0].evidence_id = "E1"; r.meta.context.items[0].evidence_id = "E1"; r.answer.candidate.citations[0].evidence_id = "E1"; }],
    ["two passages with one id", (r) => { r.packet.contexts[1].evidence_id = "E1"; }],
    ["app evidence kind is library", (r) => { r.packet.app_evidence[0].kind = "library"; }],
    ["app evidence without text", (r) => { delete r.packet.app_evidence[0].evidence_text; }],
    ["app evidence not a list", (r) => { r.packet.app_evidence = {}; }],
    ["app evidence missing", (r) => { delete r.packet.app_evidence; }],
    ["not_used entry that names evidence", (r) => { r.meta.context.items[0].status = "not_used"; r.meta.context.items[0].cited = false; r.answer.candidate.citations.shift(); }],
    ["unknown status", (r) => { r.meta.context.items[0].status = "partial"; }],
    ["ignored not a list of strings", (r) => { r.meta.context.items[0].ignored = [1]; }],
    ["reason not a string", (r) => { r.meta.context.items[0].reason = 5; }],
  ]) { const r = ok(); edit(r); bad(r, sent(), why); }
  assert.doesNotThrow(() => normalizeReply(ok(), sent()));
});

test("reply checks: citation kinds and ids (missing, unknown, wrong list, dangling)", () => {
  // Bug caught: a citation whose kind or id does not match the lists is rendered, with the wrong source.
  for (const [why, edit] of [
    ["kind missing", (r) => { delete r.answer.candidate.citations[0].kind; }],
    ["kind null", (r) => { r.answer.candidate.citations[0].kind = null; }],
    ["kind unknown", (r) => { r.answer.candidate.citations[0].kind = "web"; }],
    ["kind in capitals", (r) => { r.answer.candidate.citations[0].kind = "APP"; }],
    ["app kind on a library id", (r) => { r.answer.candidate.citations[1].kind = "app"; }],
    ["library kind on an app id", (r) => { r.answer.candidate.citations[0].kind = "library"; }],
    ["app id in neither list", (r) => { r.answer.candidate.citations[0].evidence_id = "D7"; }],
    ["library id in neither list", (r) => { r.answer.candidate.citations[1].evidence_id = "E9"; }],
    ["citation without an id", (r) => { delete r.answer.candidate.citations[1].evidence_id; }],
  ]) { const r = mixed(); edit(r); bad(r, sent(), why); }
});

test("reply checks: a cited flag must agree with the citations, in both directions", () => {
  // Bug caught: the flag is copied from Ceres, so the UI says "cited" for evidence nothing cites (or the reverse).
  let r = mixed(); r.meta.context.items[0].cited = false; bad(r, sent(), "cited true in fact, false in the acknowledgement");
  r = structuredClone(fx("resp-accepted-uncited")); r.meta.context.items[0].cited = true; bad(r, sent(), "cited false in fact, true in the acknowledgement");
  r = mixed(); r.meta.context.items[0].cited = "yes"; bad(r, sent(), "cited not a boolean");
  r = mixed(); delete r.meta.context.items[0].cited; bad(r, sent(), "cited missing");
  r = structuredClone(fx("resp-not-used")); r.meta.context.items[1].cited = true; bad(r, fx("req-two-parcels-full").context, "a not_used item cannot be cited");
  r = structuredClone(fx("resp-structure-failed")); r.meta.context.items[0].cited = true; bad(r, sent(), "no candidate, so nothing can be cited");
});

test("reply checks: a reply that is bad in one place is bad_response through ask() as well, and the raw reply is kept as detail", async () => {
  // Bug caught: ask() normalizes without the submitted items, so the checks only exist for stored replies.
  const fake = fakeCeres({ ask: () => json(200, fx("resp-bad-ack-revision")) });
  const e = await clientOn(fake).ask("q", { lang: "en", context: sent() }).catch((x) => x);
  assert.ok(isError("bad_response")(e)); assert.deepEqual(e.detail, fx("resp-bad-ack-revision"));
});

test("numbering across kinds: one numbering in order of first citation; the same item or passage keeps its number", () => {
  // Bug caught: app and library citations are numbered separately, or a repeated citation gets a new number.
  const raw = mixed();
  const [app, lib] = raw.answer.candidate.citations;
  raw.answer.candidate.citations = [lib, app, structuredClone(lib), structuredClone(app), { ...structuredClone(app), claim: "again", support_quote: "NDVI on 2026-05-11: 0.52" }];
  const r = normalizeReply(raw, sent());
  assert.deepEqual(r.citations.map((c) => [c.number, c.kind]), [[1, "library"], [2, "app"], [1, "library"], [2, "app"], [2, "app"]]);
  assert.equal(r.appEvidence[0].citationNumber, 2); assert.equal(r.passages[0].citationNumber, 1);
  assert.equal(r.citations[1].claim, app.claim); assert.equal(r.citations[4].quote, "NDVI on 2026-05-11: 0.52");
  const r2 = normalizeReply(mixed(), sent());
  assert.deepEqual(r2.citations.map((c) => c.number), [1, 2]); assert.equal(r2.appEvidence[0].citationNumber, 1); assert.equal(r2.passages[0].citationNumber, 2);
});

test("numbering across kinds: an app citation is not looked up among passages, and a library citation has no item", () => {
  // Bug caught: passage/item are filled for the wrong kind, so a "D1" citation shows a passage or an "E1" citation shows a parcel.
  const r = normalizeReply(mixed(), sent());
  const [app, lib] = r.citations;
  assert.equal(app.passage, null); assert.deepEqual(app.item, P1042); assert.equal(lib.item, null); assert.equal(lib.passage.evidenceId, "E1");
  app.item.label = "changed"; assert.equal(r.appEvidence[0].item.label, P1042.label, "item objects are not shared between citations and appEvidence");
});

test("numbering across kinds: appEvidence follows the app_evidence list and carries Ceres's text, renderer and hash unchanged", () => {
  // Bug caught: the evidence text or hash is altered, reordered or re-rendered by the client.
  const raw = fx("resp-clarify");
  const r = normalizeReply(raw, fx("req-two-parcels").context);
  assert.deepEqual(r.appEvidence.map((e) => e.evidenceId), ["D1", "D2"]);
  assert.deepEqual(r.appEvidence.map((e) => e.text), raw.packet.app_evidence.map((e) => e.evidence_text));
  assert.deepEqual(r.appEvidence.map((e) => e.textSha256), raw.packet.app_evidence.map((e) => e.evidence_text_sha256));
  assert.deepEqual(r.appEvidence.map((e) => e.renderer), ["parcel-text-v1", "parcel-text-v1"]);
  assert.deepEqual(r.raw, raw);
});

test("replies without submitted items: the old signature reads a reply to a question without context, kind library", () => {
  // Bug caught: a legacy reply gets app fields, a missing kind is an error, or a stored reply needs the new argument.
  for (const second of [undefined, null]) {
    const r = normalizeReply(fx("resp-legacy"), second);
    assert.deepEqual(r.citations.map((c) => c.kind), ["library"]); assert.deepEqual(r.appEvidence, []); assert.equal(r.context, null);
  }
  const withKind = structuredClone(fx("resp-legacy")); withKind.answer.candidate.citations[0].kind = "library";
  assert.equal(normalizeReply(withKind).citations[0].kind, "library");
});

test("replies without submitted items: an app citation or an unknown kind is bad_response when no items were submitted", () => {
  // Bug caught: an app citation is shown as a library citation (no passage, no source) because nothing says what was sent.
  const app = structuredClone(fx("resp-legacy")); app.answer.candidate.citations[0].kind = "app"; bad(app, undefined, "app kind, nothing submitted");
  const web = structuredClone(fx("resp-legacy")); web.answer.candidate.citations[0].kind = "web"; bad(web, undefined, "unknown kind");
  bad(mixed(), undefined, "a reply with app citations needs the submitted items");
  assert.throws(() => normalizeReply(fx("resp-legacy"), "P-1"), TypeError);
  assert.throws(() => normalizeReply(fx("resp-legacy"), [null]), TypeError);
});

test("replies without submitted items: additions to a reply without context are ignored, like any unknown key", () => {
  // Bug caught: an old reply that happens to carry extra keys is rejected (or a no-context reply grows a context).
  const r = structuredClone(fx("resp-legacy")); r.packet.app_evidence = []; r.meta.context = { items: [] };
  const n = normalizeReply(r);
  assert.equal(n.context, null); assert.deepEqual(n.appEvidence, []);
});

test("checkContextItems: attach-time checks match ask() (a component that validated differently would accept items ask() refuses)", () => {
  const good = JSON.parse(readFileSync(new URL("./contract/req-one-parcel.json", import.meta.url), "utf8")).context;
  const copy = checkContextItems(good);
  assert.deepEqual(copy, good);
  assert.notEqual(copy[0], good[0]);                                   // a copy, not the caller's object
  for (const name of ["req-bad-unsorted-series", "req-bad-string-number", "req-bad-duplicate-item"]) {
    const bad = JSON.parse(readFileSync(new URL(`./contract/${name}.json`, import.meta.url), "utf8")).context;
    assert.throws(() => checkContextItems(bad), (e) => e instanceof CeresError && e.kind === "bad_request", name);
  }
  const over = JSON.parse(readFileSync(new URL("./contract/req-bad-extra-keys-over.json", import.meta.url), "utf8")).context;
  const caps = { features: ["context-v0"],
                 context: JSON.parse(readFileSync(new URL("./contract/info-context-v0.json", import.meta.url), "utf8")).context };
  assert.throws(() => checkContextItems(over, caps), (e) => e.kind === "bad_request");   // the limit needs capabilities
});
