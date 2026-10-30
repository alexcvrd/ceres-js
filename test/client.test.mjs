// ceres-client.js tests (node --test). Ceres responses in test/fixtures (ANSWER, UNSUPPORTED, MEMORY; README, Test data sources); a fake fetch.
// How the client can fail, and the test that catches each:
//   * citations point at the wrong passage / numbering drifts                         → "normalizes an answer"
//   * a decline looks like an answer, or loses what is missing                        → "normalizes a decline"
//   * an invalid question still costs a ~15 s GPU answer                              → "rejects bad input before any request"
//   * HTTP errors arrive as strings an app cannot branch on                           → "maps HTTP errors to kinds"
//   * network down / timeout / user cancel are indistinguishable                       → "network, timeout and abort"
//   * the auth hook is ignored, or sends "Bearer null"                                → "getToken"
//   * a trailing slash in baseUrl breaks every URL                                    → "baseUrl"
//   * a non-Ceres response (proxy error page) crashes the app deep inside              → "bad_response"
// Added 0.2 (Ceres memory v0):
//   * conversation/profile ids never reach Ceres, or a malformed id costs a request    → "memory options"
//   * the app cannot show how Ceres understood a follow-up                              → "normalizes memory"
//   * a stateless reply grows a fake memory object                                       → "normalizes memory"
//   * the persona list is not exposed, or crashes when memory is off                     → "profiles"
//   * newConversationId makes ids Ceres refuses, or the same id twice                    → "newConversationId"
// Added 0.3 (readable sources):
//   * a document is attached to the wrong passage, missing sources crash the reply, or the
//     0.1 `passage.source` (document id) changes meaning                                → "readable sources"
//   * (0.3 review fixes) the deadline/cancel stop protecting a request once headers arrive   → "slow body", "cancel during body"
//   * a dropped connection while reading surfaces as a bare TypeError                          → "broken body"
//   * a stalled or failing getToken hangs the call or escapes as a plain Error                 → "token provider"
//   * a malformed-but-JSON reply becomes a fake NO_ANSWER or a TypeError                        → "malformed replies"
//   * numeric/object ids reach the wire, or an over-long requestId is sent                      → "id types"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCeresClient, normalizeReply, CeresError, newConversationId } from "../src/ceres-client.js";

const ANSWER = JSON.parse(readFileSync(new URL("./fixtures/ask-answer.json", import.meta.url)));
const DECLINE = JSON.parse(readFileSync(new URL("./fixtures/ask-unsupported.json", import.meta.url)));
const MEMORY = JSON.parse(readFileSync(new URL("./fixtures/ask-memory-followup.json", import.meta.url)));

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  f.calls = calls;
  return f;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("normalizes an answer", async () => {
  const fetch = fakeFetch(() => json(200, ANSWER));
  const r = await createCeresClient({ baseUrl: "http://x/ceres", fetch }).ask("q", { lang: "en" });
  assert.equal(r.decision, "ANSWER"); assert.equal(r.answered, true); assert.equal(r.reasonCode, "SUPPORTED");
  assert.equal(r.citations.length, 1);
  const c = r.citations[0];
  assert.equal(c.number, 1); assert.equal(c.evidenceId, "E2"); assert.equal(c.passage.evidenceId, "E2");
  assert.ok(c.passage.text.includes(c.quote), "the quote is inside the cited passage");
  assert.deepEqual(r.passages.map((p) => p.cited), [false, true, false, false, false]);
  assert.equal(r.passages[0].pageIndex, 14); assert.equal(r.passages[0].source, "mars-europe-2013-06-vol21-no6");
  assert.equal(r.passages[1].pageIndex, null); assert.equal(r.passages[1].source, "mars-europe-2013-06-vol21-no6");
  assert.deepEqual(r.passages[1].warnings, ["unmatched_locator"]);
  assert.equal(r.meta.releaseId, "all/release-attempt-0001"); assert.ok(r.meta.latencyMs.total > 0);
  assert.deepEqual(r.raw, ANSWER);
});

test("normalizes a decline", () => {
  const r = normalizeReply(DECLINE);
  assert.equal(r.answered, false); assert.equal(r.decision, "UNSUPPORTED"); assert.equal(r.reasonCode, "NO_RELEVANT_SUPPORT");
  assert.equal(r.citations.length, 0); assert.equal(r.missingInformation.length, 2);
  assert.ok(r.answer.length > 0, "a decline still carries a message for the user");
  assert.ok(r.passages.every((p) => !p.cited));
});

test("rejects bad input before any request", async () => {
  const fetch = fakeFetch(() => json(200, ANSWER));
  const c = createCeresClient({ baseUrl: "http://x", fetch });
  for (const [q, o, kind] of [["", { lang: "en" }, "bad_request"], ["  ", { lang: "en" }, "bad_request"],
                               ["x".repeat(2001), { lang: "en" }, "too_long"], ["q", { lang: "de" }, "bad_request"], ["q", undefined, "bad_request"]]) {
    await assert.rejects(c.ask(q, o), (e) => e instanceof CeresError && e.kind === kind);
  }
  assert.equal(fetch.calls.length, 0);
});

test("maps HTTP errors to kinds", async () => {
  for (const [status, kind, retryable] of [[401, "unauthorized", false], [413, "too_long", false], [422, "bad_request", false],
                                           [429, "busy", true], [503, "not_ready", true], [500, "server_error", true]]) {
    const fetch = fakeFetch(() => json(status, { detail: `ceres ${status}` }));
    await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "en" }),
      (e) => e.kind === kind && e.status === status && e.message === `ceres ${status}` && e.retryable === retryable);
  }
});

test("network, timeout and abort", async () => {
  const down = fakeFetch(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch: down }).ask("q", { lang: "en" }), (e) => e.kind === "network");
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch: hang, timeoutMs: 30 }).ask("q", { lang: "en" }), (e) => e.kind === "timeout");
  const ctl = new AbortController();
  const p = createCeresClient({ baseUrl: "http://x", fetch: hang }).ask("q", { lang: "en", signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.kind === "aborted");
});

test("getToken", async () => {
  const fetch = fakeFetch(() => json(200, ANSWER));
  await createCeresClient({ baseUrl: "http://x", fetch, getToken: async () => "tok123" }).ask("q", { lang: "en" });
  assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer tok123");
  await createCeresClient({ baseUrl: "http://x", fetch, getToken: () => null }).ask("q", { lang: "en" });
  assert.equal(fetch.calls[1].init.headers.Authorization, undefined);
  await createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "ro", requestId: "r1" });
  assert.deepEqual(JSON.parse(fetch.calls[2].init.body), { question: "q", lang: "ro", request_id: "r1" });
});

test("baseUrl", async () => {
  const fetch = fakeFetch(() => json(200, { ready: true }));
  await createCeresClient({ baseUrl: "http://x/ceres///", fetch }).health();
  assert.equal(fetch.calls[0].url, "http://x/ceres/health");
  assert.throws(() => createCeresClient({}), TypeError);
});

test("bad_response", async () => {
  const fetch = fakeFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "en" }), (e) => e.kind === "bad_response");
});

test("numbers citations by passage, in order of first citation", () => {
  // Bug: every passage gets number 1, or two citations of one passage get different numbers.
  const raw = structuredClone(ANSWER);
  const q = (id) => raw.packet.contexts.find((c) => c.evidence_id === id).evidence_text.slice(0, 40);
  raw.answer.candidate.citations = [{ claim: "a", evidence_id: "E4", support_quote: q("E4") },
                                    { claim: "b", evidence_id: "E2", support_quote: q("E2") },
                                    { claim: "c", evidence_id: "E4", support_quote: q("E4") }];
  const r = normalizeReply(raw);
  assert.deepEqual(r.citations.map((c) => c.number), [1, 2, 1]);
  assert.deepEqual(r.passages.map((p) => p.citationNumber), [null, 2, null, 1, null]);
});

test("memory options", async () => {
  const fetch = fakeFetch(() => json(200, MEMORY));
  const c = createCeresClient({ baseUrl: "http://x", fetch });
  await c.ask("And for maize?", { lang: "en", conversationId: "c-0123456789", profileId: "dolj-maize-dry" });
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { question: "And for maize?", lang: "en", conversation_id: "c-0123456789", profile_id: "dolj-maize-dry" });
  await c.ask("q", { lang: "en" });
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body), { question: "q", lang: "en" });   // stateless stays stateless
  for (const bad of [{ conversationId: "short" }, { conversationId: "has space in it" }, { profileId: "Bad_Persona" }]) {
    await assert.rejects(c.ask("q", { lang: "en", ...bad }), (e) => e.kind === "bad_request");
  }
  assert.equal(fetch.calls.length, 2);
});

test("normalizes memory", () => {
  const r = normalizeReply(MEMORY);
  assert.equal(r.memory.turn, 2); assert.equal(r.memory.isFollowup, true); assert.equal(r.memory.rewriteStatus, "ok");
  assert.equal(r.memory.understoodAs, "What is the optimal sowing density for maize?");
  assert.match(r.memory.searchQuery, /maize/);
  assert.equal(normalizeReply(ANSWER).memory, null);
});

test("profiles", async () => {
  const on = fakeFetch(() => json(200, { memory_enabled: true, profiles: [{ id: "dolj-maize-dry", role: "farmer", language: "ro", summary: "Farmer in Dolj" }] }));
  const ps = await createCeresClient({ baseUrl: "http://x/ceres", fetch: on }).profiles();
  assert.equal(on.calls[0].url, "http://x/ceres/v1/profiles");
  assert.deepEqual(ps, [{ id: "dolj-maize-dry", role: "farmer", language: "ro", summary: "Farmer in Dolj" }]);
  const off = fakeFetch(() => json(200, { memory_enabled: false, profiles: [] }));
  assert.deepEqual(await createCeresClient({ baseUrl: "http://x", fetch: off }).profiles(), []);
});

test("newConversationId", () => {
  const a = newConversationId(), b = newConversationId();
  assert.match(a, /^[A-Za-z0-9_-]{8,64}$/); assert.notEqual(a, b);
});

test("readable sources", () => {
  const raw = structuredClone(ANSWER);
  raw.meta.sources = [{ evidence_id: "E2", work_id: "w:x", title: "MARS Bulletin: Crop monitoring in Europe, Vol. 21 No. 6",
                        authors: ["JRC MARS"], language: "en", page_label: "section 1" }];
  const r = normalizeReply(raw);
  assert.equal(r.passages[1].source, "mars-europe-2013-06-vol21-no6");  // the document id field keeps its meaning (0.1 API)
  assert.equal(r.passages[1].document.display, "MARS Bulletin: Crop monitoring in Europe, Vol. 21 No. 6 — JRC MARS, section 1");
  assert.equal(r.passages[0].document, null);                      // no entry for E1: null, not a crash or a borrowed title
  assert.equal(normalizeReply(ANSWER).passages[0].document, null); // Ceres without sources
});

// --- review fixes (0.3.0) ---
const hangUntilAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
const neverEnds = () => new Promise(() => {});

test("slow body: the timeout still applies while the response body is being read", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: neverEnds });        // headers arrive, the body never does
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch, timeoutMs: 30 }).ask("q", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "timeout");
});

test("cancel during body: the caller's abort ends a request whose headers have arrived", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: neverEnds });
  const ctl = new AbortController();
  const p = createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "en", signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, (e) => e instanceof CeresError && e.kind === "aborted");
});

test("broken body: a connection that dies while the body is read is a CeresError(network)", async () => {
  const fetch = async () => ({ ok: true, status: 200, text: async () => { throw new TypeError("terminated"); } });
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "en" }), (e) => e instanceof CeresError && e.kind === "network");
});

test("token provider: a rejection is a CeresError and sends nothing; a stall obeys the timeout and cancel", async () => {
  const f = fakeFetch(() => json(200, ANSWER));
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch: f, getToken: async () => { throw new Error("session expired"); } }).ask("q", { lang: "en" }),
    (e) => e instanceof CeresError && e.kind === "unauthorized");
  assert.equal(f.calls.length, 0, "no request without a token");
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch: f, getToken: neverEnds, timeoutMs: 30 }).ask("q", { lang: "en" }), (e) => e.kind === "timeout");
  const ctl = new AbortController(); ctl.abort();
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch: f, getToken: neverEnds }).ask("q", { lang: "en", signal: ctl.signal }), (e) => e.kind === "aborted");
});

test("malformed replies: JSON of the wrong shape is bad_response, never a fake answer or a TypeError", async () => {
  const good = JSON.parse(JSON.stringify(ANSWER));
  const cases = {
    "empty packet and answer": { packet: {}, answer: {} },
    "null context": { ...good, packet: { ...good.packet, contexts: [null] } },
    "contexts not a list": { ...good, packet: { ...good.packet, contexts: {} } },
    "citations an object": { ...good, answer: { ...good.answer, candidate: { ...good.answer.candidate, citations: {} } } },
    "null citation": { ...good, answer: { ...good.answer, candidate: { ...good.answer.candidate, citations: [null] } } },
    "no candidate": { ...good, answer: { state: "x" } },
    "unknown answer state": { ...good, answer: { ...good.answer, state: "DONE" } },
    "VALIDATED without a candidate": { ...good, answer: { state: "VALIDATED" } },
    "candidate without a decision": { ...good, answer: { ...good.answer, candidate: { citations: [] } } },
    "sources an object": { ...good, meta: { ...good.meta, sources: {} } },
    "null source": { ...good, meta: { ...good.meta, sources: [null] } },
  };
  for (const [name, raw] of Object.entries(cases)) assert.throws(() => normalizeReply(raw), (e) => e instanceof CeresError && e.kind === "bad_response", name);
  const fetch = fakeFetch(() => json(200, cases["null context"]));
  await assert.rejects(createCeresClient({ baseUrl: "http://x", fetch }).ask("q", { lang: "en" }), (e) => e.kind === "bad_response");
});

test("a STRUCTURE_FAILED reply carries no candidate and is not a bad_response", () => {
  // Bug: the shape check demanded a candidate on every reply, so a legitimate failed answer became a client error.
  const raw = { ...JSON.parse(JSON.stringify(ANSWER)), answer: { question_id: "q", state: "STRUCTURE_FAILED", attempts: 2, errors: ["invalid_response"] } };
  const r = normalizeReply(raw);
  assert.equal(r.answered, false);
  assert.deepEqual(r.citations, []);
});

test("id types: non-string ids and an over-long requestId are refused before any request", async () => {
  const fetch = fakeFetch(() => json(200, ANSWER));
  const c = createCeresClient({ baseUrl: "http://x", fetch });
  for (const opts of [{ conversationId: 12345678 }, { profileId: 12 }, { requestId: { bad: true } }, { requestId: 5 }, { requestId: "" },
                      { requestId: "r".repeat(201) }])
    await assert.rejects(c.ask("q", { lang: "en", ...opts }), (e) => e.kind === "bad_request", JSON.stringify(opts));
  assert.equal(fetch.calls.length, 0);
  await c.ask("q", { lang: "en", requestId: "r".repeat(200) });
  assert.equal(JSON.parse(fetch.calls[0].init.body).request_id.length, 200);
});
