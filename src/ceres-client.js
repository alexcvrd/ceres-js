// ceres-client.js — a drop-in client for the Ceres agronomy RAG service (Veridian).
//
// One ES module, no dependencies, no build step. Uses only `fetch` and `AbortController`, so it runs unchanged in browsers
// (plain pages, React, Vue), React Native and Node 18+. It never touches the page (no DOM): rendering is the app's job.
//
//   import { createCeresClient } from "./ceres-client.js";
//   const ceres = createCeresClient({ baseUrl: "/ceres" });          // your backend's pass-through to Ceres
//   const reply = await ceres.ask("What is the optimal sowing density for sunflower?", { lang: "en" });
//   reply.decision  // "ANSWER" | "UNSUPPORTED" | ...      reply.answer, reply.citations, reply.passages
//   await ceres.ask("Is this crop behind schedule?", { lang: "en", context: [parcel] });   // attach a parcel (see README, Context items)
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
 * @property {string} quote                   The exact supporting words in the passage (or in the item's evidence text).
 * @property {"library" | "app"} kind          "library": a passage of the release; "app": an item the app attached (context-v0).
 * @property {Passage | null} passage          The cited passage; null for an app citation.
 * @property {ItemRef | null} item             The cited item; null for a library citation.
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
 * @property {AppEvidence[]} appEvidence      The items Ceres showed to the answer model, in request order; [] without context.
 * @property {ContextEntry[] | null} context  What Ceres did with each submitted item, in request order; null when no context was sent.
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
 * @typedef {Object} ItemRef                  Which item, and which snapshot of it.
 * @property {string} type                    "parcel"
 * @property {string} id
 * @property {string} revision
 * @property {string} label                   Display only; untrusted.
 *
 * @typedef {Object} AppEvidence              An item's text as Ceres rendered it for the answer model (what "app" citations point at).
 * @property {string} evidenceId              "D1", "D2", … — what app citations point at.
 * @property {ItemRef} item
 * @property {string} text                    Written by Ceres; its format is versioned by `renderer`. Show it as text, never parse it.
 * @property {string | null} renderer         e.g. "parcel-text-v1".
 * @property {string | null} textSha256       Lower-case hex SHA-256 of the UTF-8 bytes of `text`, as sent by Ceres.
 * @property {boolean} cited                  Whether the answer cites it.
 * @property {number | null} citationNumber   Shared numbering with library citations; null when not cited.
 *
 * @typedef {Object} ContextEntry             What Ceres did with one submitted item.
 * @property {string} type
 * @property {string} id
 * @property {string} revision
 * @property {"accepted" | "not_used"} status "accepted": the item's text was shown to the answer model; "not_used": valid but not shown.
 * @property {string | null} evidenceId       The item's "D…" id when accepted, else null.
 * @property {boolean} cited                  Whether a citation points at the item's evidence.
 * @property {string[]} ignored               JSON Pointers (relative to the item) of unknown keys Ceres did not use, e.g. "/data/indices/lai".
 * @property {string | null} reason           Why a not_used item was not shown, e.g. "packet_full".
 *
 * @typedef {Object} Observation              One point of a vegetation-index series.
 * @property {string} date                    Calendar-valid "YYYY-MM-DD".
 * @property {number} value                   Finite number.
 *
 * @typedef {Object} ParcelData               The known keys of a parcel's `data`; all optional, never null. Other keys are allowed
 *                                            within the limits Ceres advertises (see `supports`).
 * @property {string} [crop]                  1-60 characters.
 * @property {number} [season]                Integer, 1900-2100.
 * @property {number} [areaHa]                Finite, > 0.
 * @property {string} [region]                1-80 characters.
 * @property {string} [sowingDate]            "YYYY-MM-DD".
 * @property {string} [harvestDate]           "YYYY-MM-DD".
 * @property {Record<string, Observation[]>} [indices]  Index name (1-32 characters from a-z 0-9 _) → 1..max_points observations
 *                                            with strictly increasing dates.
 *
 * @typedef {Object} ContextItem              Something the app attaches to a question (context-v0: a farm parcel).
 * @property {"parcel"} type
 * @property {string} id                      1-64 characters from A-Z a-z 0-9 . _ : -
 * @property {string} revision                1-64 printable ASCII characters; names one snapshot of the item.
 * @property {string} label                   1-120 characters of text; display only.
 * @property {ParcelData & Record<string, any>} data
 *
 * @typedef {Object} Capabilities             What the connected Ceres supports (from GET /v1/info).
 * @property {string[]} features              e.g. ["context-v0"]; [] for a Ceres without `features`.
 * @property {{types: string[], indices: string[], limits: {max_items: number, max_series: number, max_points: number,
 *             max_extra_keys: number, max_extra_string_chars: number}} | null} context   Present when "context-v0" is supported.
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
   * @param {"bad_request" | "unauthorized" | "too_long" | "conflict" | "unsupported" | "busy" | "not_ready" | "server_error" | "network" | "timeout" | "aborted" | "bad_response"} kind
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

const STATUS_KIND = { 400: "bad_request", 401: "unauthorized", 403: "unauthorized", 409: "conflict", 413: "too_long", 422: "bad_request",
                      429: "busy", 503: "not_ready" };
// A pass-through (the proxies in proxy/, or a backend of your own) reports its own upstream failure with one of these details.
const UPSTREAM_FAILURE = { 502: ["upstream_unreachable", "network"], 504: ["upstream_timeout", "timeout"] };
const MAX_QUESTION_CHARS = 2000;
const MAX_REQUEST_ID_CHARS = 200;   // the Ceres API's limit for request_id
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const CONTEXT_FEATURE = "context-v0";
const LIMIT_NAMES = ["max_items", "max_series", "max_points", "max_extra_keys", "max_extra_string_chars"];
const ITEM_KEYS = ["type", "id", "revision", "label", "data"];
const PARCEL_KEYS = new Set(["crop", "season", "areaHa", "region", "sowingDate", "harvestDate", "indices"]);
const ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const REVISION_RE = /^[\x21-\x7e]{1,64}$/;
const INDEX_NAME_RE = /^[a-z0-9_]{1,32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_EXTRA_DEPTH = 4;          // levels an unknown value may nest below `data`
const MAX_SNAPSHOT_DEPTH = 16;      // guards the copy of an item against cycles; the real depth limits are checked on the copy

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

  // What the connected Ceres supports, from the last discovery; null while unknown. `capsGeneration` changes whenever the cache
  // is dropped, so a discovery that started before the drop cannot refill it with what it saw earlier.
  let caps = null;
  let capsGeneration = 0;
  const dropCapabilities = () => { caps = null; capsGeneration++; };

  // One deadline and one cancellation signal cover everything `work` does: for each HTTP request it sends, getting the token,
  // the fetch and reading the body, and for an ask also the discovery in front of it. Whichever happens first (timeout, the
  // caller's abort, or a real failure) ends the work, and the timer and the abort listener are removed only when it is
  // completely done. `work` receives `send(path, init)`, which makes one request under that deadline.
  async function withDeadline(signal, work) {
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
    const send = async (path, init = {}) => {
      if (controller.signal.aborted) throw toError(null, "network", "The request was stopped");   // nothing goes out after the deadline
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
        let kind = STATUS_KIND[res.status] ?? (res.status >= 500 ? "server_error" : "bad_request");
        let message = typeof detail === "string" ? detail : `Ceres returned HTTP ${res.status}`;
        if (UPSTREAM_FAILURE[res.status]?.[0] === detail) kind = UPSTREAM_FAILURE[res.status][1];
        else if (res.status === 422 && isLegacyContextRefusal(detail)) {
          dropCapabilities();   // the Ceres behind this client has no context; what the cache says is stale
          kind = "unsupported"; message = `This Ceres does not support ${CONTEXT_FEATURE}`;
        }
        throw new CeresError(kind, message, { status: res.status, detail });
      }
      return body;
    };
    try { return await work(send); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  const request = (path, init, signal) => withDeadline(signal, (send) => send(path, init));

  // GET /v1/info through `send`, and the cache refreshed from it. A malformed answer drops the cache: nothing it held is trusted.
  async function loadInfo(send) {
    const generation = capsGeneration;
    const body = await send("/v1/info");
    let found;
    try { found = parseCapabilities(body); } catch (err) { dropCapabilities(); throw err; }
    if (generation === capsGeneration) caps = found;
    return { body, found };
  }

  return {
    /**
     * Ask one question. Without `conversationId` each question stands alone; with it, Ceres remembers the earlier turns of that
     * conversation ("And for maize?" works). `profileId` tells Ceres who is asking (a static persona in v0); keep it the same for the
     * whole conversation. Pass `requestId` when you may retry: Ceres replays a completed request instead of storing the turn twice.
     * @param {string} question
     * @param {{lang: Lang, signal?: AbortSignal, requestId?: string, conversationId?: string, profileId?: string, context?: ContextItem[]}} opts
     *   `context`: items (a parcel) to attach to this question. Absent: no items, and any Ceres will do. An array, also `[]`: Ceres
     *   must support "context-v0" (else `unsupported`, before the question is sent); the items are checked first (`bad_request`) and
     *   copied when `ask` is called, so later changes to them do not reach the request.
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
      // The snapshot is taken here, before the first await: the request carries what the items were when ask() was called.
      let items;
      if (opts.context !== undefined) {
        items = readItems(() => {
          if (!Array.isArray(opts.context)) throw new CeresError("bad_request", "context must be an array of items (leave it out to attach nothing)");
          return snapshotItems(opts.context);
        });
        checkContext(items, null);   // the rules that need no capabilities
      }
      const payload = { question: q, lang: opts.lang, ...(opts.requestId != null ? { request_id: opts.requestId } : {}),
                        ...(opts.conversationId ? { conversation_id: opts.conversationId } : {}),
                        ...(opts.profileId ? { profile_id: opts.profileId } : {}), ...(items ? { context: items } : {}) };
      const raw = await withDeadline(opts.signal, async (send) => {
        if (items) {
          const found = caps ?? (await loadInfo(send)).found;
          if (!found.features.includes(CONTEXT_FEATURE))
            throw new CeresError("unsupported", `This Ceres does not support ${CONTEXT_FEATURE}, so the question was not sent`);
          checkContext(items, found.context);
        }
        return send("/v1/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      });
      return normalizeReply(raw, items);
    },

    /** Liveness and readiness: `{ready, ...}` from Ceres (no auth needed). */
    async health(opts = {}) { return request("/health", {}, opts.signal); },

    /** Which release and route Ceres serves (the `/v1/info` body). It also refreshes what `supports` knows. */
    async info(opts = {}) { return withDeadline(opts.signal, async (send) => (await loadInfo(send)).body); },

    /**
     * Whether the connected Ceres supports a feature, e.g. `"context-v0"`. The first call asks Ceres (`GET /v1/info`); later calls
     * answer from that cache until `refreshCapabilities()` or `info()` replaces it. A Ceres without `features` supports nothing.
     * @param {string} feature
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<boolean>}
     */
    async supports(feature, opts = {}) {
      const found = caps ?? (await withDeadline(opts.signal, async (send) => (await loadInfo(send)).found));
      return found.features.includes(feature);
    },

    /**
     * Ask Ceres what it supports again (`GET /v1/info`), replacing the cache. Call it after Ceres is upgraded.
     * @param {{signal?: AbortSignal}} [opts]
     * @returns {Promise<Capabilities>}
     */
    async refreshCapabilities(opts = {}) {
      const { found } = await withDeadline(opts.signal, loadInfo);
      return structuredCopy(found);
    },

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

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isPlainObject = (x) => isObj(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const structuredCopy = (x) => JSON.parse(JSON.stringify(x));
const codePoints = (s) => { let n = 0; for (const _ of s) n++; return n; };

/** True for the 422 an old Ceres answers when the request has a `context` field it does not know. */
function isLegacyContextRefusal(detail) {
  return Array.isArray(detail) && detail.some((e) => isObj(e) && e.type === "extra_forbidden" && Array.isArray(e.loc)
    && e.loc.length === 2 && e.loc[0] === "body" && e.loc[1] === "context");
}

/** The capabilities in a GET /v1/info body. `features` absent: a Ceres without context. Malformed: bad_response. */
function parseCapabilities(info) {
  const bad = (why) => new CeresError("bad_response", `Ceres returned an unexpected /v1/info (${why})`, { detail: info });
  if (!isObj(info)) throw bad("not an object");
  const features = info.features;
  if (features === undefined) return { features: [], context: null };
  if (!Array.isArray(features) || !features.every((f) => typeof f === "string")) throw bad("features must be a list of strings");
  if (!features.includes(CONTEXT_FEATURE)) return { features: [...features], context: null };
  const c = info.context;
  if (!isObj(c)) throw bad(`${CONTEXT_FEATURE} is advertised without a context object`);
  for (const k of ["types", "indices"])
    if (!Array.isArray(c[k]) || !c[k].every((x) => typeof x === "string")) throw bad(`context.${k} must be a list of strings`);
  if (!isObj(c.limits)) throw bad("context.limits is missing");
  for (const k of LIMIT_NAMES)
    if (!Number.isSafeInteger(c.limits[k]) || c.limits[k] < 1) throw bad(`context.limits.${k} must be a positive integer`);
  return { features: [...features], context: { types: [...c.types], indices: [...c.indices],
                                               limits: Object.fromEntries(LIMIT_NAMES.map((k) => [k, c.limits[k]])) } };
}

// --- context items: the rules an item must meet ---

/**
 * Check context items the way `ask()` does and return the copy it would send; throws `CeresError` (`bad_request`) on the first
 * failure. Without `capabilities` (the result of `refreshCapabilities()`) only the rules that need none are checked; with them,
 * the advertised types and limits too. For apps and components that validate an item when it is attached, before asking.
 * @param {ContextItem[]} items
 * @param {Capabilities | null} [capabilities]
 * @returns {ContextItem[]}
 */
export function checkContextItems(items, capabilities = null) {
  const copy = readItems(() => {
    if (!Array.isArray(items)) throw new CeresError("bad_request", "context must be an array of items");
    return snapshotItems(items);
  });
  checkContext(copy, capabilities?.context ?? null);
  return copy;
}

const refuse = (path, why) => new CeresError("bad_request", `context${path}: ${why}`);

/** Run a read of the caller's items. Whatever the items throw while being read (a throwing getter, a revoked Proxy) is a bad_request. */
function readItems(read) {
  try {
    return read();
  } catch (e) {
    if (e instanceof CeresError) throw e;
    throw new CeresError("bad_request", "context: the items could not be read (reading them threw an error)", { cause: e });
  }
}

/** A deep copy of items made only of JSON values (finite numbers, plain objects and arrays); anything else is bad_request. */
function snapshotItems(items) {
  const copy = (v, path, depth) => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw refuse(path, "numbers must be finite"); return v; }
    if (depth > MAX_SNAPSHOT_DEPTH) throw refuse(path, "is nested too deeply");
    if (Array.isArray(v)) return Array.from({ length: v.length }, (_, i) => copy(v[i], `${path}[${i}]`, depth + 1));
    if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).map((k) => [k, copy(v[k], `${path}.${k}`, depth + 1)]));
    throw refuse(path, "must be JSON (null, boolean, finite number, string, array or plain object)");
  };
  return copy(items, "", 0);
}

function isCalendarDate(v) {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return mo >= 1 && mo <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

/**
 * Check a snapshot of items against the item rules and throw the first failure as bad_request. `caps` is the `context` part
 * of the capabilities, or null for the rules that need none (everything except the advertised types and limits, and which index
 * names count as unknown keys).
 */
function checkContext(items, caps) {
  const lim = caps?.limits ?? {};
  const text = (path, v, max) => {
    if (typeof v !== "string" || v.length > 2 * max || v.length === 0 || codePoints(v) > max || CONTROL_RE.test(v))
      throw refuse(path, `must be text of 1-${max} characters, without control characters`);
  };
  const date = (path, v) => { if (!isCalendarDate(v)) throw refuse(path, "must be a calendar date YYYY-MM-DD"); };
  // Every object key inside an unknown value counts once; returns that count.
  const unknownValue = (path, v, depth) => {
    if (typeof v === "string") {
      if (lim.max_extra_string_chars !== undefined && codePoints(v) > lim.max_extra_string_chars)
        throw refuse(path, `strings in unknown keys are at most ${lim.max_extra_string_chars} characters`);
      return 0;
    }
    if (v === null || typeof v !== "object") return 0;
    if (depth > MAX_EXTRA_DEPTH) throw refuse(path, `unknown keys nest at most ${MAX_EXTRA_DEPTH} levels below data`);
    if (Array.isArray(v)) return v.reduce((n, x, i) => n + unknownValue(`${path}[${i}]`, x, depth + 1), 0);
    return Object.entries(v).reduce((n, [k, x]) => n + 1 + unknownValue(`${path}.${k}`, x, depth + 1), 0);
  };
  const series = (path, s) => {
    if (!Array.isArray(s) || s.length === 0) throw refuse(path, "a series is a non-empty array (leave an empty one out)");
    if (lim.max_points !== undefined && s.length > lim.max_points) throw refuse(path, `a series has at most ${lim.max_points} observations`);
    let previous = null;
    s.forEach((o, i) => {
      const p = `${path}[${i}]`;
      if (!isPlainObject(o)) throw refuse(p, "an observation is an object");
      for (const k of Object.keys(o)) if (k !== "date" && k !== "value") throw refuse(`${p}.${k}`, "an observation has only date and value");
      date(`${p}.date`, o.date);
      if (previous !== null && o.date <= previous) throw refuse(`${p}.date`, "dates must be strictly increasing");
      previous = o.date;
      if (typeof o.value !== "number" || !Number.isFinite(o.value)) throw refuse(`${p}.value`, "must be a finite number");
    });
  };
  const parcelData = (path, data) => {
    if (!isPlainObject(data)) throw refuse(path, "must be an object");
    let extra = 0;
    for (const [key, v] of Object.entries(data)) {
      const p = `${path}.${key}`;
      if (!PARCEL_KEYS.has(key)) { extra += 1 + unknownValue(p, v, 1); continue; }
      if (key === "crop") text(p, v, 60);
      else if (key === "region") text(p, v, 80);
      else if (key === "season") { if (!Number.isInteger(v) || v < 1900 || v > 2100) throw refuse(p, "must be an integer from 1900 to 2100"); }
      else if (key === "areaHa") { if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw refuse(p, "must be a finite number above 0"); }
      else if (key === "indices") {
        if (!isPlainObject(v)) throw refuse(p, "must be an object of series");
        const names = Object.keys(v);
        if (lim.max_series !== undefined && names.length > lim.max_series) throw refuse(p, `at most ${lim.max_series} series per item`);
        for (const name of names) {
          if (!INDEX_NAME_RE.test(name)) throw refuse(`${p}.${name}`, "an index name is 1-32 characters from a-z 0-9 _");
          series(`${p}.${name}`, v[name]);
          if (caps && !caps.indices.includes(name)) extra++;
        }
      } else date(p, v);   // sowingDate, harvestDate
    }
    if (lim.max_extra_keys !== undefined && extra > lim.max_extra_keys)
      throw refuse(path, `${extra} unknown keys; at most ${lim.max_extra_keys} are allowed`);
  };
  if (lim.max_items !== undefined && items.length > lim.max_items) throw refuse("", `at most ${lim.max_items} items per question`);
  const seen = new Set();
  items.forEach((item, i) => {
    const at = `[${i}]`;
    if (!isPlainObject(item)) throw refuse(at, "an item is an object");
    for (const k of Object.keys(item)) if (!ITEM_KEYS.includes(k)) throw refuse(`${at}.${k}`, `an item has only ${ITEM_KEYS.join(", ")}`);
    for (const k of ITEM_KEYS) if (!Object.prototype.hasOwnProperty.call(item, k)) throw refuse(`${at}.${k}`, "is required");
    if (item.type !== "parcel" || (caps && !caps.types.includes(item.type))) throw refuse(`${at}.type`, 'must be "parcel", and a type Ceres announces');
    if (typeof item.id !== "string" || !ITEM_ID_RE.test(item.id)) throw refuse(`${at}.id`, "must be 1-64 characters from A-Z a-z 0-9 . _ : -");
    const key = JSON.stringify([item.type, item.id]);
    if (seen.has(key)) throw refuse(`${at}.id`, `a second ${item.type} with id ${item.id}; send each item once`);
    seen.add(key);
    if (typeof item.revision !== "string" || !REVISION_RE.test(item.revision)) throw refuse(`${at}.revision`, "must be 1-64 printable ASCII characters");
    text(`${at}.label`, item.label, 120);
    parcelData(`${at}.data`, item.data);
  });
}

/**
 * Turn a raw Ceres /v1/ask response into a Reply. Exported so apps (and tests) can normalize stored responses.
 * Pass `submitted`, the items the question was sent with (also `[]`), to normalize the reply to a question that carried context:
 * the reply must then acknowledge exactly those items (anything else is bad_response). Without it the reply is read as the reply
 * to a question without context: `appEvidence` is [], `context` is null, and every citation is a library citation.
 * @param {any} raw
 * @param {ContextItem[]} [submitted]
 * @returns {Reply}
 */
export function normalizeReply(raw, submitted) {
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
  if (isObj(given) && given.decision !== undefined && typeof given.decision !== "string") throw bad("answer.candidate.decision must be a string");
  if (isObj(given) && given.missing_information !== undefined && !(Array.isArray(given.missing_information) && given.missing_information.every((x) => typeof x === "string")))
    throw bad("answer.candidate.missing_information must be a list of strings");
  const srcList = isObj(raw.meta) ? raw.meta.sources : undefined;
  if (srcList !== undefined && srcList !== null && (!Array.isArray(srcList) || !srcList.every(isObj))) throw bad("meta.sources must be a list of objects");
  if (submitted != null && (!Array.isArray(submitted) || !submitted.every(isObj))) throw new TypeError("normalizeReply: submitted must be an array of items");
  const candidate = isObj(given) ? given : { citations: [] };
  const contexts = raw.packet.contexts;
  const sources = new Map((srcList || []).map((x) => [x.evidence_id, x]));
  const kinds = (candidate.citations || []).map((c) => {
    if (c.kind === undefined && !Array.isArray(submitted)) return "library";   // a reply to a question without context has no kinds
    if (c.kind !== "library" && !(c.kind === "app" && Array.isArray(submitted))) throw bad(`citation kind ${JSON.stringify(c.kind)} is not valid here`);
    return c.kind;
  });
  const sentContext = Array.isArray(submitted) ? readContextReply(raw, submitted, candidate.citations || [], kinds, bad) : null;
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
    citations: (candidate.citations || []).map((c, i) => ({
      number: numbers.get(c.evidence_id), kind: kinds[i], evidenceId: c.evidence_id, claim: c.claim || "", quote: c.support_quote || "",
      passage: kinds[i] === "library" ? byId.get(c.evidence_id) ?? null : null,
      item: kinds[i] === "app" ? itemRef(sentContext.evidence.get(c.evidence_id).item) : null,
    })),
    passages,
    appEvidence: sentContext ? [...sentContext.evidence.values()].map((e) => ({
      evidenceId: e.evidence_id, item: itemRef(e.item), text: e.evidence_text,
      renderer: typeof e.renderer === "string" ? e.renderer : null,
      textSha256: typeof e.evidence_text_sha256 === "string" ? e.evidence_text_sha256 : null,
      cited: numbers.has(e.evidence_id), citationNumber: numbers.get(e.evidence_id) ?? null,
    })) : [],
    context: sentContext ? sentContext.entries : null,
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

const itemRef = (item) => ({ type: item.type, id: item.id, revision: item.revision, label: item.label });

/**
 * The structural checks on a reply to a question that carried context. Returns the app evidence by id and the
 * normalized acknowledgement; throws `bad(...)` when the reply does not answer exactly the items that were submitted.
 */
function readContextReply(raw, submitted, citations, kinds, bad) {
  const list = raw.packet.app_evidence;
  if (!Array.isArray(list) || !list.every(isObj)) throw bad("packet.app_evidence is missing although context was sent");
  const evidence = new Map();
  for (const e of list) {
    if (typeof e.evidence_id !== "string" || e.kind !== "app" || !isObj(e.item) || typeof e.evidence_text !== "string")
      throw bad("an app_evidence entry is malformed");
    if (evidence.has(e.evidence_id)) throw bad(`evidence id ${e.evidence_id} appears twice`);
    evidence.set(e.evidence_id, e);
  }
  const library = new Set(raw.packet.contexts.map((c) => c.evidence_id));
  if (library.size !== raw.packet.contexts.length || [...evidence.keys()].some((id) => library.has(id))) throw bad("an evidence id appears twice");

  citations.forEach((c, i) => {
    const mine = kinds[i] === "app" ? evidence : library;
    if (mine.has(c.evidence_id)) return;
    const other = kinds[i] === "app" ? library.has(c.evidence_id) : evidence.has(c.evidence_id);
    throw bad(other ? `citation ${i} has kind ${kinds[i]} but names an evidence id of the other kind`
                    : `citation ${i} names ${JSON.stringify(c.evidence_id)}, which is in neither list`);
  });

  const ack = isObj(raw.meta) ? raw.meta.context : undefined;
  if (!isObj(ack) || !Array.isArray(ack.items) || !ack.items.every(isObj)) throw bad("meta.context is missing although context was sent");
  if (ack.items.length !== submitted.length) throw bad(`meta.context has ${ack.items.length} entries for ${submitted.length} submitted items`);
  const citedApp = new Set(citations.filter((_, i) => kinds[i] === "app").map((c) => c.evidence_id));
  const named = new Set();
  const entries = ack.items.map((e, i) => {
    const s = submitted[i];
    if (e.type !== s.type || e.id !== s.id || e.revision !== s.revision)
      throw bad(`meta.context entry ${i} does not echo the submitted item (type, id, revision)`);
    if (e.status === "accepted") {
      const ev = evidence.get(e.evidence_id);
      if (!ev || named.has(e.evidence_id) || ["type", "id", "revision", "label"].some((k) => ev.item[k] !== s[k]))
        throw bad(`meta.context entry ${i} is accepted but its evidence is not an app_evidence entry for the submitted item`);
      named.add(e.evidence_id);
    } else if (e.status === "not_used") {
      if (e.evidence_id !== null && e.evidence_id !== undefined) throw bad(`meta.context entry ${i} is not_used but names evidence`);
    } else throw bad(`meta.context entry ${i} has an unknown status`);
    if (e.cited !== (e.status === "accepted" && citedApp.has(e.evidence_id))) throw bad(`meta.context entry ${i}: cited disagrees with the citations`);
    if (e.ignored !== undefined && !(Array.isArray(e.ignored) && e.ignored.every((x) => typeof x === "string"))) throw bad(`meta.context entry ${i}: ignored must be a list of strings`);
    if (e.reason !== undefined && e.reason !== null && typeof e.reason !== "string") throw bad(`meta.context entry ${i}: reason must be a string`);
    return { type: e.type, id: e.id, revision: e.revision, status: e.status, evidenceId: e.status === "accepted" ? e.evidence_id : null,
             cited: e.cited, ignored: [...(e.ignored || [])], reason: e.reason ?? null };
  });
  if ([...evidence.keys()].some((id) => !named.has(id))) throw bad("an app_evidence entry is named by no accepted item");
  return { evidence, entries };
}

function toDocument(x, sectionId) {
  if (!x) return null;
  const authors = Array.isArray(x.authors) ? x.authors : [];
  const who = authors.length > 2 ? `${authors[0]} et al.` : authors.join(", ");
  const parts = [x.title || sectionId, who, x.page_label].filter(Boolean);
  return { title: x.title ?? null, authors, language: x.language ?? null, pageLabel: x.page_label ?? null,
           display: parts.length > 1 ? `${parts[0]} — ${parts.slice(1).join(", ")}` : parts[0] };
}
