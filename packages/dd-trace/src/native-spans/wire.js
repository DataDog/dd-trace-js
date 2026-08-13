'use strict'

/**
 * Wire format shared by the JS `EventWriter` and the Rust decoder.
 *
 * Every record in the event log is a run of `Uint32Array` words: word 0 is the
 * kind tag, the rest are that kind's fields. A per-span kind has two tags — an
 * elided-id form that refers to whatever context is currently entered, and an
 * explicit-id form carrying the subject span id in words 1-2.
 *
 * The design doc has decode infer the form from one bit of entered-state instead
 * of from the tag. That does not work: the adaptive-entry algorithm deliberately
 * leaves a context entered while writing an explicit record for a *different*
 * span (the `A, A, B, A, A` case), so at `B`'s record the entered bit is set on
 * `A` and decode has no way to tell `B`'s record is in the long form. Splitting
 * the tag resolves it for free — the tag word is spent either way, the elided
 * form is still two words shorter, and every cost in the doc's worked examples
 * holds unchanged.
 *
 * Keep in sync with `native/src/wire.rs`; `test/native-spans/wire.spec.js` pins
 * the two against each other.
 */

const KIND_SPAN_START = 1
const KIND_SET_TAG_STRING = 2
const KIND_SET_TAG_STRING_ID = 3
const KIND_SET_TAG_NUMBER = 4
const KIND_SET_TAG_NUMBER_ID = 5
const KIND_ADD_LINK = 6
const KIND_ADD_LINK_ID = 7
const KIND_ADD_EVENT = 8
const KIND_ADD_EVENT_ID = 9
const KIND_FINISH = 10
const KIND_FINISH_ID = 11
const KIND_REGISTER_STRING = 12
const KIND_PROCESS_INFO = 13
const KIND_SEGMENT_START = 14
const KIND_ENTER_CONTEXT_KEEP_LAST = 15
const KIND_ENTER_CONTEXT_NEW = 16
const KIND_WEB_REQUEST_START = 17
const KIND_WEB_REQUEST_FINISH = 18
const KIND_SPAN_ERROR = 19
const KIND_MIDDLEWARE_START = 20

const KIND_COUNT = 21

/** Record width in words, kind tag included, indexed by kind. */
const WIDTHS = new Uint8Array(KIND_COUNT)
/**
 * Doubles consumed from the shared doubles buffer per record, indexed by kind.
 * Positional, like `REGISTER_STRING`'s bytes: the nth float-carrying record in
 * the word stream draws the nth entry. Nothing here is tied to `SET_TAG_NUMBER` —
 * a future float-carrying kind is one row in this table and shares the same
 * buffer and cursor.
 */
const DOUBLE_COUNTS = new Uint8Array(KIND_COUNT)

// [segmentIdHi, segmentIdLo, spanIdHi, spanIdLo, parentIdHi, parentIdLo, startHi, startLo]
WIDTHS[KIND_SPAN_START] = 9
// [keyId, valueId]
WIDTHS[KIND_SET_TAG_STRING] = 3
WIDTHS[KIND_SET_TAG_STRING_ID] = 5
// [keyId] — the value comes from the doubles buffer, not from a word
WIDTHS[KIND_SET_TAG_NUMBER] = 2
WIDTHS[KIND_SET_TAG_NUMBER_ID] = 4
DOUBLE_COUNTS[KIND_SET_TAG_NUMBER] = 1
DOUBLE_COUNTS[KIND_SET_TAG_NUMBER_ID] = 1
// [targetIdHi, targetIdLo, attrsId]
WIDTHS[KIND_ADD_LINK] = 4
WIDTHS[KIND_ADD_LINK_ID] = 6
// [nameId, timeHi, timeLo, attrsId]
WIDTHS[KIND_ADD_EVENT] = 5
WIDTHS[KIND_ADD_EVENT_ID] = 7
// [durationHi, durationLo]
WIDTHS[KIND_FINISH] = 3
WIDTHS[KIND_FINISH_ID] = 5
// [stringId, byteLength] — process-global, never has an id form
WIDTHS[KIND_REGISTER_STRING] = 3
// [serviceId, envId, versionId, languageId, pid, processTagsId]
WIDTHS[KIND_PROCESS_INFO] = 7
// [segmentIdHi, segmentIdLo, traceIdHiHi, traceIdHiLo, traceIdLoHi, traceIdLoLo]
WIDTHS[KIND_SEGMENT_START] = 7
WIDTHS[KIND_ENTER_CONTEXT_KEEP_LAST] = 1
// [idHi, idLo]
WIDTHS[KIND_ENTER_CONTEXT_NEW] = 3

// The specialized web-server records. A web request attaches to a segment the same way
// `SPAN_START` does rather than implying one: it is the segment root today, but an
// inferred proxy span — the shape Serverless produces — would sit above it in the same
// segment, and a kind that assumed otherwise would have to be redesigned to allow it.
// [segmentIdHi, segmentIdLo, spanIdHi, spanIdLo, parentIdHi, parentIdLo, startHi, startLo,
//  methodId, urlId]
WIDTHS[KIND_WEB_REQUEST_START] = 11
// [idHi, idLo, durationHi, durationLo, statusCode, routeId, framework]
//
// No error field: a 5xx is derivable from the status, and a thrown error is rare enough
// that its three strings get their own record rather than three empty words on every
// successful request.
WIDTHS[KIND_WEB_REQUEST_FINISH] = 8
// [segmentIdHi, segmentIdLo, spanIdHi, spanIdLo, parentIdHi, parentIdLo, startHi, startLo,
//  resourceId, framework]
//
// A middleware span's shape is fixed apart from its handler name: no type, no span kind,
// and a `component` / `_dd.integration` pair that follows from the framework word. Only
// the handler name is interned. There is no matching finish record, because a plain
// `FINISH` already carries nothing but the duration — a specialized one would save
// nothing, so middleware reuses it.
WIDTHS[KIND_MIDDLEWARE_START] = 11
// [idHi, idLo, messageId, typeId, stackId]
//
// Not web-specific: an error is an error. Every span reaches this instead of the four
// records `setTag('error', err)` used to write — three `SET_TAG_STRING`s for the message,
// type and stack, plus a `SET_TAG_NUMBER` for the flag, which the assembler now infers
// from the record's mere presence.
WIDTHS[KIND_SPAN_ERROR] = 6

/** Widest record on the wire, used to size the pre-flush headroom. */
let MAX_RECORD_WORDS = 0
for (let kind = 0; kind < KIND_COUNT; kind++) {
  if (WIDTHS[kind] > MAX_RECORD_WORDS) MAX_RECORD_WORDS = WIDTHS[kind]
}

/**
 * Strings with fixed ids baked into both sides at build time. These never emit
 * a `REGISTER_STRING` record, at any frequency — they sit outside the resettable
 * id range, so the per-flush interning reset (see `event-writer.js`) never costs
 * anything for the keys and values that recur on essentially every span.
 *
 * Append only, never reorder: an id is a permanent index into this list.
 */
const RESERVED_STRINGS = [
  '', // id 0 — the absent string (no link attributes, no span type, ...)
  'operation.name',
  'service.name',
  'resource.name',
  'span.type',
  'error',
  'error.message',
  'error.type',
  'error.stack',
  'language',
  'javascript',
  'span.kind',
  'component',
  'server',
  'client',
  'internal',
  'producer',
  'consumer',
  'http.method',
  'http.url',
  'http.status_code',
  'http.route',
  'http.useragent',
  'http.client_ip',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'web',
  'http',
  'express',
  'env',
  'version',
  'service',
  'process_id',
  'runtime-id',
  '_dd.p.tid',
  '_dd.p.dm',
  '_dd.integration',
  '_dd.base_service',
  '_dd.top_level',
  '_dd.measured',
  '_sampling_priority_v1',
  'opentracing',
  'events',
  // Names the web-server events resolve to rather than send. `http.route`,
  // `http.method` and the rest of that family are already reserved above.
  'web.request',
  'express.request',
  'router',
  'router.middleware',
  'express.middleware',
]

/**
 * Framework ids carried by `WEB_REQUEST_FINISH`. The operation name, the
 * `component` tag and the `_dd.integration` tag all follow from this one word, so
 * none of them travels on the wire.
 */
const FRAMEWORK_HTTP = 0
const FRAMEWORK_EXPRESS = 1

/**
 * Which host dispatched a middleware layer. Separate from `FRAMEWORK_*` above: those name
 * the server framework, these name the router, and an express app's own layers dispatch as
 * `router` rather than `express`.
 */
const MIDDLEWARE_ROUTER = 0
const MIDDLEWARE_EXPRESS = 1

/**
 * First id handed out by the per-flush interning table. Reserved ids occupy
 * `0..RESERVED_STRINGS.length`; the gap up to here is headroom so appending a
 * reserved string never shifts the dynamic range.
 */
const FIRST_DYNAMIC_STRING_ID = 64

/* istanbul ignore if */
if (RESERVED_STRINGS.length > FIRST_DYNAMIC_STRING_ID) {
  throw new Error('native-spans: reserved string ids overflow into the dynamic range')
}

module.exports = {
  DOUBLE_COUNTS,
  FIRST_DYNAMIC_STRING_ID,
  FRAMEWORK_EXPRESS,
  FRAMEWORK_HTTP,
  KIND_ADD_EVENT,
  KIND_ADD_EVENT_ID,
  KIND_ADD_LINK,
  KIND_ADD_LINK_ID,
  KIND_COUNT,
  KIND_ENTER_CONTEXT_KEEP_LAST,
  KIND_ENTER_CONTEXT_NEW,
  KIND_FINISH,
  KIND_FINISH_ID,
  KIND_PROCESS_INFO,
  KIND_REGISTER_STRING,
  KIND_SEGMENT_START,
  KIND_SET_TAG_NUMBER,
  KIND_SET_TAG_NUMBER_ID,
  KIND_SET_TAG_STRING,
  KIND_SET_TAG_STRING_ID,
  KIND_MIDDLEWARE_START,
  KIND_SPAN_ERROR,
  KIND_SPAN_START,
  KIND_WEB_REQUEST_FINISH,
  KIND_WEB_REQUEST_START,
  MAX_RECORD_WORDS,
  MIDDLEWARE_EXPRESS,
  MIDDLEWARE_ROUTER,
  RESERVED_STRINGS,
  WIDTHS,
}
