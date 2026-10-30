// ceres-client.js — a drop-in client for the Ceres agronomy RAG service (Veridian).
//
// One ES module, no dependencies, no build step. Uses only `fetch` and `AbortController`, so it runs unchanged in browsers
// (plain pages, React, Vue), React Native and Node 18+. It never touches the page (no DOM): rendering is the app's job.
//
//   import { createCeresClient } from "./ceres-client.js";
//   const ceres = createCeresClient({ baseUrl: "/ceres" });          // your backend's pass-through to Ceres
//   const reply = await ceres.ask("What is the optimal sowing density for sunflower?", { lang: "en" });
//   reply.decision  // "ANSWER" | "UNSUPPORTED" | ...      reply.answer, reply.citations, reply.passages
//
// Security: never put a Ceres API key in a browser or a mobile app. Point `baseUrl` at your own backend, which adds the key
// (see proxy/), and which must authenticate your user before forwarding. `getToken` is the hook for that per-user auth; it is
// optional and Ceres itself does not read the token.
//

export const VERSION = "0.3.0";   // 0.2: conversation memory + personas; 0.3: readable sources (passage.document)
/** The Ceres API this client speaks (Ceres service, POST /v1/ask, response = {packet, answer, meta}). */
export const CERES_API = "v1";

/**
 * @typedef {"en" | "ro"} Lang
 *
 * @typedef {Object} ClientOptions
 * @property {string} baseUrl                 Where Ceres's /v1 API is reachable: your backend's pass-through ("/ceres",
 *                                            "https://api.example.com/ceres") or, for local demos only, Ceres itself.
 * @property {() => (string | null | undefined | Promise<string | null | undefined>)} [getToken]
 *                                            Returns a bearer token for the current user; sent as `Authorization: Bearer …`.
 * @property {number} [timeoutMs=120000]      Give up after this long (an answer takes ~10-20 s).
 * @property {typeof fetch} [fetch]           A fetch implementation (default: the global one).
 * @property {Record<string, string>} [headers] Extra headers on every request.
 *
 * @typedef {Object} Passage                  One retrieved passage the answer may cite.
 * @property {string} evidenceId              "E1".."E5" — what citations point at.
 * @property {string} source                  Source document id, e.g. "example-work-0001".
 * @property {number | null} pageIndex        0-based page of the source, when the passage is a page.
 * @property {string} sectionId               The full section id (source + page or section).
 * @property {string} text                    The passage text.
 * @property {boolean} cited                  Whether the answer cites it.
 * @property {number | null} citationNumber   1, 2, … in order of first citation; null when not cited.
 * @property {string[]} warnings              Quality warnings from the pipeline (e.g. "unmatched_locator").
 * @property {Document | null} document        Title, authors and page of the passage's document (when Ceres sends them).
 *
 * @typedef {Object} Document
 * @property {string | null} title             e.g. "MARS Bulletin: Crop monitoring in Europe, Vol. 21 No. 6"
 * @property {string[]} authors
 * @property {string | null} language
 * @property {string | null} pageLabel         "PDF p. 76" (the PDF page, not the printed page number) or "section 5"
 * @property {string} display                  Ready to show: "Title — Authors, PDF p. 76" (falls back to the section id)
 *
 * @typedef {Object} Citation
 * @property {number} number                  Display number (shared by citations of the same passage).
 * @property {string} evidenceId
 * @property {string} claim                   The part of the answer this supports.
 * @property {string} quote                   The exact supporting words in the passage.
 * @property {Passage | null} passage
 *
 * @typedef {Object} Reply
 * @property {string} decision                "ANSWER", or a decline: "UNSUPPORTED", … (Ceres decides; treat unknown values as declines).
 * @property {boolean} answered               decision === "ANSWER".
 * @property {string} answer                  The text to show the user (also the decline message).
 * @property {string | null} confidence       "HIGH" | "MEDIUM" | "LOW" | null.
 * @property {string | null} reasonCode       e.g. "SUPPORTED", "NO_RELEVANT_SUPPORT", "LIVE_DATA_REQUIRED".
 * @property {Citation[]} citations
 * @property {Passage[]} passages
 * @property {string[]} missingInformation    For declines: what the library lacks.
 * @property {string} question
 * @property {Lang} lang
 * @property {{releaseId: string | null, routeId: string | null, latencyMs: Record<string, number>, state: string | null}} meta
 * @property {Memory | null} memory          Present when the request used a conversation or a persona.
 * @property {any} raw                        The full Ceres response, unchanged.
 *
 * @typedef {Object} Memory                   How Ceres understood the question (memory v0).
 * @property {string | null} conversationId
 * @property {number | null} turn             1, 2, … within the conversation (null without a conversation).
 * @property {string | null} profileId
 * @property {string} understoodAs            The stand-alone question Ceres answered ("And for maize?" → "…sowing density for maize?").
 * @property {string} searchQuery             What Ceres searched the library with.
 * @property {boolean} isFollowup
 * @property {"ok" | "skipped" | "fallback" | "transport_failed"} rewriteStatus
 *
 * @typedef {Object} Profile                  A user profile Ceres knows (static personas in v0).
 * @property {string} id
 * @property {string} role
 * @property {string | null} language
 * @property {string} summary
 */

/** Every failure of a request is a CeresError with a `kind` an app can switch on. */
export class CeresError extends Error {
  /**
   * @param {"bad_request" | "unauthorized" | "too_long" | "busy" | "not_ready" | "server_error" | "network" | "timeout" | "aborted" | "bad_response"} kind
   * @param {string} message
   * @param {{status?: number, detail?: any, cause?: any}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "CeresError";
    this.kind = kind;
    this.status = extra.status ?? null;
    this.detail = extra.detail ?? null;
    if (extra.cause) this.cause = extra.cause;
  }
  /** True when trying again later may work. */
  get retryable() { return ["busy", "not_ready", "network", "timeout", "server_error"].includes(this.kind); }
}

const STATUS_KIND = { 400: "bad_request", 401: "unauthorized", 403: "unauthorized", 413: "too_long", 422: "bad_request",
                      429: "busy", 503: "not_ready" };
const MAX_QUESTION_CHARS = 2000;
const MAX_REQUEST_ID_CHARS = 200;   // the Ceres API's limit for request_id
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** A fresh conversation id (start a new one for each new chat; reuse it for every follow-up). */
export function newConversationId() {
  const c = globalThis.crypto;
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");   // React Native without crypto
  return "c-" + raw;
}

/**
 * Create a client.
 * @param {ClientOptions} options
 */
export function createCeresClient(options) {
  if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) throw new TypeError("createCeresClient: baseUrl is required");
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new TypeError("createCeresClient: no fetch available; pass options.fetch");
  const timeoutMs = options.timeoutMs ?? 120000;

  // One deadline and one cancellation signal cover everything a request does: getting the token, the fetch and reading the
  // body. Whichever happens first (timeout, the caller's abort, or a real failure) ends the request, and the timer and the
  // abort listener are removed only when the request is completely done.
  async function request(path, init = {}, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // Rejects when the request is cancelled or times out, even if the token provider or fetch ignores the signal.
    const stopped = new Promise((_, reject) => {
      const stop = () => reject(new Error("stopped"));
      if (controller.signal.aborted) stop(); else controller.signal.addEventListener("abort", stop, { once: true });
    });
    stopped.catch(() => {});
    const guard = (p) => Promise.race([p, stopped]);
    // Turns any failure into a CeresError: a timeout and a cancellation keep their own kind whatever threw.
    const toError = (err, kind, message) => {
      if (err instanceof CeresError) return err;
      if (timedOut) return new CeresError("timeout", `Ceres did not answer within ${Math.round(timeoutMs / 1000)} s`, { cause: err });
      if (signal?.aborted) return new CeresError("aborted", "The request was cancelled", { cause: err });
      return new CeresError(kind, message, { cause: err });
    };
    try {
      const headers = { Accept: "application/json", ...(options.headers || {}), ...(init.headers || {}) };
      if (options.getToken) {
        let token;
        try { token = await guard(Promise.resolve().then(() => options.getToken())); }
        catch (err) { throw toError(err, "unauthorized", "getToken failed, so no request was sent"); }
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      let res;
      try { res = await guard(doFetch(base + path, { ...init, headers, signal: controller.signal })); }
      catch (err) { throw toError(err, "network", `Cannot reach Ceres at ${base}`); }
      if (!res || typeof res.text !== "function") throw new CeresError("bad_response", "fetch returned something that is not a response");
      let text;
      try { text = await guard(res.text()); }
      catch (err) { throw toError(err, "network", "The connection to Ceres broke while the answer was being read"); }
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        const detail = body && typeof body === "object" && "detail" in body ? body.detail : body;
        const kind = STATUS_KIND[res.status] ?? (res.status >= 500 ? "server_error" : "bad_request");
        throw new CeresError(kind, typeof detail === "string" ? detail : `Ceres returned HTTP ${res.status}`, { status: res.status, detail });
      }
      return body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  return {
    /**
     * Ask one question. Without `conversationId` each question stands alone; with it, Ceres remembers the earlier turns of that
     * conversation ("And for maize?" works). `profileId` tells Ceres who is asking (a static persona in v0); keep it the same for the
     * whole conversation. Pass `requestId` when you may retry: Ceres replays a completed request instead of storing the turn twice.
     * @param {string} question
     * @param {{lang: Lang, signal?: AbortSignal, requestId?: string, conversationId?: string, profileId?: string}} opts
     * @returns {Promise<Reply>}
     */
    async ask(question, opts) {
      const q = typeof question === "string" ? question.trim() : "";
      if (!q) throw new CeresError("bad_request", "The question is empty");
      if (q.length > MAX_QUESTION_CHARS) throw new CeresError("too_long", `The question is longer than ${MAX_QUESTION_CHARS} characters`);
      if (!opts || (opts.lang !== "en" && opts.lang !== "ro")) throw new CeresError("bad_request", 'lang must be "en" or "ro"');
      if (opts.conversationId != null && (typeof opts.conversationId !== "string" || !CONVERSATION_ID_RE.test(opts.conversationId)))
        throw new CeresError("bad_request", "conversationId must be 8-64 letters, digits, '_' or '-' (use newConversationId())");
      if (opts.profileId != null && (typeof opts.profileId !== "string" || !PROFILE_ID_RE.test(opts.profileId)))
        throw new CeresError("bad_request", "profileId is not a valid profile id");
      if (opts.requestId != null && (typeof opts.requestId !== "string" || !opts.requestId || opts.requestId.length > MAX_REQUEST_ID_CHARS))
        throw new CeresError("bad_request", `requestId must be a string of 1-${MAX_REQUEST_ID_CHARS} characters`);
      const payload = { question: q, lang: opts.lang, ...(opts.requestId != null ? { request_id: opts.requestId } : {}),
                        ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
                        ...(opts.profileId ? { profile_id: opts.profileId } : {}) };
      const raw = await request("/v1/ask", { method: "POST", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify(payload) }, opts.signal);
      return normalizeReply(raw);
    },

    /** Liveness and readiness: `{ready, ...}` from Ceres (no auth needed). */
    async health(opts = {}) { return request("/health", {}, opts.signal); },

    /** Which release and route Ceres serves. */
    async info(opts = {}) { return request("/v1/info", {}, opts.signal); },

    /**
     * The user profiles Ceres knows (static personas in memory v0). `[]` when memory is off.
     * @returns {Promise<Profile[]>}
     */
    async profiles(opts = {}) {
      const body = await request("/v1/profiles", {}, opts.signal);
      return Array.isArray(body?.profiles) ? body.profiles.map((p) => ({ id: p.id, role: p.role, language: p.language ?? null,
                                                                         summary: p.summary })) : [];
    },
  };
}

/**
 * Turn a raw Ceres /v1/ask response into a Reply. Exported so apps (and tests) can normalize stored responses.
 * @param {any} raw
 * @returns {Reply}
 */
export function normalizeReply(raw) {
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const bad = (why) => new CeresError("bad_response", `Ceres returned an unexpected response (${why})`, { detail: raw });
  if (!isObj(raw) || !isObj(raw.packet) || !isObj(raw.answer)) throw bad("packet or answer is missing");
  if (!Array.isArray(raw.packet.contexts) || !raw.packet.contexts.every(isObj)) throw bad("packet.contexts must be a list of objects");
  // Ceres sends a candidate only on a VALIDATED answer; STRUCTURE_FAILED and TRANSPORT_FAILED replies carry none.
  if (!["VALIDATED", "STRUCTURE_FAILED", "TRANSPORT_FAILED"].includes(raw.answer.state)) throw bad("answer.state is not a Ceres answer state");
  const given = raw.answer.candidate;
  if (raw.answer.state === "VALIDATED" && !isObj(given)) throw bad("answer.candidate is missing on a VALIDATED answer");
  if (given !== undefined && given !== null && !isObj(given)) throw bad("answer.candidate must be an object");
  if (isObj(given) && (!Array.isArray(given.citations) || !given.citations.every(isObj))) throw bad("answer.candidate.citations must be a list of objects");
  if (raw.answer.state === "VALIDATED" && typeof given.decision !== "string") throw bad("answer.candidate.decision is missing");
  const srcList = isObj(raw.meta) ? raw.meta.sources : undefined;
  if (srcList !== undefined && srcList !== null && (!Array.isArray(srcList) || !srcList.every(isObj))) throw bad("meta.sources must be a list of objects");
  const candidate = isObj(given) ? given : { citations: [] };
  const contexts = raw.packet.contexts;
  const sources = new Map((srcList || []).map((x) => [x.evidence_id, x]));
  const numbers = new Map();
  for (const c of candidate.citations || []) if (!numbers.has(c.evidence_id)) numbers.set(c.evidence_id, numbers.size + 1);
  /** @type {Passage[]} */
  const passages = contexts.map((c) => {
    const sectionId = c.parent_id || "";
    const page = /:page-(\d+)$/.exec(sectionId);
    return {
      evidenceId: c.evidence_id,
      source: sectionId.split(":")[0].replace(/-section-\d+$/, ""),
      pageIndex: page ? Number(page[1]) : null,
      sectionId,
      text: c.evidence_text || "",
      cited: numbers.has(c.evidence_id),
      citationNumber: numbers.get(c.evidence_id) ?? null,
      warnings: Array.isArray(c.warnings) ? c.warnings : [],
      document: toDocument(sources.get(c.evidence_id), sectionId),
    };
  });
  const byId = new Map(passages.map((p) => [p.evidenceId, p]));
  const decision = candidate.decision || "NO_ANSWER";
  const meta = raw.meta || {};
  return {
    decision,
    answered: decision === "ANSWER",
    answer: candidate.user_answer || "",
    confidence: candidate.confidence ?? null,
    reasonCode: candidate.reason_code ?? null,
    citations: (candidate.citations || []).map((c) => ({
      number: numbers.get(c.evidence_id), evidenceId: c.evidence_id, claim: c.claim || "", quote: c.support_quote || "",
      passage: byId.get(c.evidence_id) ?? null,
    })),
    passages,
    missingInformation: candidate.missing_information || [],
    question: raw.packet.question || "",
    lang: raw.packet.language,
    meta: { releaseId: meta.release_attempt_id ?? null, routeId: meta.route_id ?? null, latencyMs: meta.latency_ms || {},
            state: raw.answer.state ?? null },
    memory: meta.memory ? {
      conversationId: meta.memory.conversation_id ?? null, turn: meta.memory.turn ?? null, profileId: meta.memory.profile_id ?? null,
      understoodAs: meta.memory.standalone_question || raw.packet.question || "", searchQuery: meta.memory.retrieval_query || "",
      isFollowup: !!meta.memory.is_followup, rewriteStatus: meta.memory.rewrite_status || "skipped",
    } : null,
    raw,
  };
}

function toDocument(x, sectionId) {
  if (!x) return null;
  const authors = Array.isArray(x.authors) ? x.authors : [];
  const who = authors.length > 2 ? `${authors[0]} et al.` : authors.join(", ");
  const parts = [x.title || sectionId, who, x.page_label].filter(Boolean);
  return { title: x.title ?? null, authors, language: x.language ?? null, pageLabel: x.page_label ?? null,
           display: parts.length > 1 ? `${parts[0]} — ${parts.slice(1).join(", ")}` : parts[0] };
}
