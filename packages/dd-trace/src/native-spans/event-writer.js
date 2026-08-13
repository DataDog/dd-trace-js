'use strict'

const log = require('../log')
const { isFalse } = require('../util')
const { LANES, splitMillisToNanoLanes, subtractNanoLanes } = require('./clock')
const createFlusher = require('./flusher')
const {
  DOUBLE_COUNTS,
  FIRST_DYNAMIC_STRING_ID,
  KIND_ADD_EVENT,
  KIND_ADD_EVENT_ID,
  KIND_ADD_LINK,
  KIND_ADD_LINK_ID,
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
  KIND_SPAN_START,
  KIND_MIDDLEWARE_START,
  KIND_SPAN_ERROR,
  KIND_WEB_REQUEST_FINISH,
  KIND_WEB_REQUEST_START,
  MAX_RECORD_WORDS,
  RESERVED_STRINGS,
} = require('./wire')

// ~16 MB across the three buffers, the combined flush threshold.
const EVENT_WORDS = 3 * 1024 * 1024 // 12 MB
const DOUBLE_SLOTS = 128 * 1024 // 1 MB
const STRING_BYTES = 3 * 1024 * 1024 // 3 MB

// Longest UTF-8 run one string may contribute. Tag values are capped at 25k
// characters upstream, which is 100 kB at 4 bytes per character.
const MAX_STRING_BYTES = 128 * 1024

// Pre-flush headroom. Once a cursor crosses its limit the next write flushes
// first, so a single record — plus the two `REGISTER_STRING` records its key and
// value may need, and the two strings themselves — always fits in what is left.
const EVENT_LIMIT = EVENT_WORDS - (MAX_RECORD_WORDS + 6)
const DOUBLE_LIMIT = DOUBLE_SLOTS - 1
const STRING_LIMIT = STRING_BYTES - 2 * MAX_STRING_BYTES

const FLUSH_INTERVAL_MS = 1000

/**
 * @typedef {ReturnType<import('../config')>} Config
 */

/**
 * Pre-built reserved-id table, copied into a fresh `Map` on every reset.
 *
 * @type {Array<[string, number]>}
 */
const RESERVED_ENTRIES = []
for (const [index, value] of RESERVED_STRINGS.entries()) {
  RESERVED_ENTRIES.push([value, index])
}

/**
 * Turns `Span` method calls into fixed-width records in a shared buffer. Nothing
 * here builds a data structure the tracer reads back: a call writes its lanes and
 * returns.
 *
 * Three buffers, each a plain non-resizable `ArrayBuffer` so the Rust side can
 * borrow them for the duration of a `flush()` call without the backing pointer
 * moving: the event log (`Uint32Array` records), a doubles buffer (one `f64` per
 * float-carrying record, consumed positionally) and a string blob (raw UTF-8,
 * also positional). Cursors reset to zero the moment `flush()` returns; the
 * contents are never zeroed, since nothing ever reads past the length it was
 * told to decode.
 */
class EventWriter {
  // Views over three plain, fixed-size `ArrayBuffer`s. Fixed size matters: a
  // resizable buffer can move its backing pointer on `.resize()`, and Rust holds
  // a borrow of all three across the whole `flush()` call. The string blob is
  // wrapped in a `Buffer` for `utf8Write`, allocated from an explicit
  // `ArrayBuffer` so its `byteOffset` is zero rather than an offset into a pool.
  #events = new Uint32Array(EVENT_WORDS)
  #doubles = new Float64Array(DOUBLE_SLOTS)
  #strings = Buffer.from(new ArrayBuffer(STRING_BYTES))

  #eventCursor = 0
  #doubleCursor = 0
  #stringCursor = 0

  /** @type {Map<string, number>} */
  #stringMap = new Map(RESERVED_ENTRIES)
  #nextStringId = FIRST_DYNAMIC_STRING_ID

  // Identity elision state, mirrored one-for-one by the decoder.
  /** @type {object | undefined} Who the elided form currently refers to. */
  #enteredContext
  /** @type {object | undefined} Who the previous write was for — the proof tracker. */
  #pendingContext
  /** @type {object | undefined} Who most recently got a real id on the wire. */
  #lastExplicitContext

  #flusher

  /**
   * @param {Config} [config]
   */
  constructor (config) {
    this.#flusher = createFlusher(
      this.#events.buffer,
      this.#doubles.buffer,
      this.#strings.buffer,
      config
    )

    const timer = setInterval(() => { this.flush() }, FLUSH_INTERVAL_MS)
    timer.unref?.()

    globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers?.add(() => { this.flush() })

    this.#processInfo(config)
  }

  /**
   * `[serviceId, envId, versionId, languageId, pid, processTagsId]`, once per
   * process. Rust resolves these to owned strings during this batch's decode, so
   * they outlive the interning window they were registered in.
   *
   * The process tags are `config.tags` — `runtime-id`, the remote-config client id,
   * `version`, and any global tags the user set — serialized once here instead of
   * re-sent per span. The generic path still writes them per span through
   * `addTags(config.tags)`; a specialized event sends no tags at all, so the assembler
   * applies these to those spans.
   *
   * @param {Config} [config]
   */
  #processInfo (config) {
    const serviceId = this.#intern(config?.service ?? '')
    const environmentId = this.#intern(config?.env ?? '')
    const versionId = this.#intern(config?.version ?? '')
    const languageId = this.#intern('javascript')
    const processTagsId = this.#intern(serializeProcessTags(config?.tags))

    const events = this.#events
    const cursor = this.#eventCursor
    events[cursor] = KIND_PROCESS_INFO
    events[cursor + 1] = serviceId
    events[cursor + 2] = environmentId
    events[cursor + 3] = versionId
    events[cursor + 4] = languageId
    events[cursor + 5] = process.pid
    events[cursor + 6] = processTagsId
    this.#eventCursor = cursor + 7
  }

  /**
   * `[segmentIdHi, segmentIdLo, traceIdHiHi, traceIdHiLo, traceIdLoHi, traceIdLoLo]`,
   * once per local trace root. Maps a segment onto its distributed trace so no
   * per-span record has to carry the 128-bit trace id.
   *
   * @param {import('./span_context')} context
   */
  segmentStart (context) {
    if (this.#eventCursor >= EVENT_LIMIT) this.flush()

    const segmentId = context._segmentId
    const traceId = context._traceId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_SEGMENT_START
    events[cursor + 1] = segmentId.hi
    events[cursor + 2] = segmentId.lo
    events[cursor + 3] = traceId.upperHi
    events[cursor + 4] = traceId.upperLo
    events[cursor + 5] = traceId.hi
    events[cursor + 6] = traceId.lo
    this.#eventCursor = cursor + 7
  }

  /**
   * `[segmentIdHi, segmentIdLo, spanIdHi, spanIdLo, parentIdHi, parentIdLo, startHi, startLo]`.
   * Carries no name, service, resource or type — those are ordinary tags with
   * reserved key ids.
   *
   * A fresh context can never equal `#enteredContext` or `#pendingContext`, so
   * `SPAN_START` is always the "first touch" branch of the elision algorithm; it
   * seeds that state directly instead of going through `#enterContext`.
   *
   * @param {import('./span_context')} context
   * @param {number} startHi Start time in integer-nanosecond lanes, already split
   * by the span — which keeps them to subtract from at finish.
   * @param {number} startLo
   */
  spanStart (context, startHi, startLo) {
    if (this.#eventCursor >= EVENT_LIMIT) this.flush()

    const segmentId = context._segmentId
    const spanId = context._spanId
    const parentId = context._parentId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_SPAN_START
    events[cursor + 1] = segmentId.hi
    events[cursor + 2] = segmentId.lo
    events[cursor + 3] = spanId.hi
    events[cursor + 4] = spanId.lo
    events[cursor + 5] = parentId.hi
    events[cursor + 6] = parentId.lo
    events[cursor + 7] = startHi
    events[cursor + 8] = startLo
    this.#eventCursor = cursor + 9

    this.#lastExplicitContext = context
    this.#pendingContext = context
  }

  /**
   * `[keyId, valueId]`, or `[idHi, idLo, keyId, valueId]` when the subject span
   * has to be named explicitly.
   *
   * @param {import('./span_context')} context
   * @param {string} key
   * @param {string} value
   */
  setTagString (context, key, value) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const explicit = this.#enterContext(context)
    const keyId = this.#intern(key)
    const valueId = this.#intern(value)

    const events = this.#events
    let cursor = this.#eventCursor
    if (explicit) {
      const spanId = context._spanId
      events[cursor] = KIND_SET_TAG_STRING_ID
      events[cursor + 1] = spanId.hi
      events[cursor + 2] = spanId.lo
      cursor += 2
    } else {
      events[cursor] = KIND_SET_TAG_STRING
    }
    events[cursor + 1] = keyId
    events[cursor + 2] = valueId
    this.#eventCursor = cursor + 3
  }

  /**
   * `[keyId]`, or `[idHi, idLo, keyId]`. The value goes to the shared doubles
   * buffer and is consumed positionally on decode, so it costs no word here.
   *
   * @param {import('./span_context')} context
   * @param {string} key
   * @param {number} value
   */
  setTagNumber (context, key, value) {
    if (
      this.#eventCursor >= EVENT_LIMIT ||
      this.#stringCursor >= STRING_LIMIT ||
      this.#doubleCursor >= DOUBLE_LIMIT
    ) {
      this.flush()
    }

    const explicit = this.#enterContext(context)
    const keyId = this.#intern(key)

    this.#doubles[this.#doubleCursor++] = value

    const events = this.#events
    let cursor = this.#eventCursor
    if (explicit) {
      const spanId = context._spanId
      events[cursor] = KIND_SET_TAG_NUMBER_ID
      events[cursor + 1] = spanId.hi
      events[cursor + 2] = spanId.lo
      cursor += 2
    } else {
      events[cursor] = KIND_SET_TAG_NUMBER
    }
    events[cursor + 1] = keyId
    this.#eventCursor = cursor + 2
  }

  /**
   * `[targetIdHi, targetIdLo, attrsId]`, or the explicit-id form. The target is
   * a data field, not the record's subject, so it is always written out in full
   * regardless of value — elision only ever applies to whose operation this is.
   *
   * @param {import('./span_context')} context
   * @param {import('./id').NativeId} targetSpanId
   * @param {string} serializedAttributes
   */
  addLink (context, targetSpanId, serializedAttributes) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const explicit = this.#enterContext(context)
    const attributesId = this.#intern(serializedAttributes)

    const events = this.#events
    let cursor = this.#eventCursor
    if (explicit) {
      const spanId = context._spanId
      events[cursor] = KIND_ADD_LINK_ID
      events[cursor + 1] = spanId.hi
      events[cursor + 2] = spanId.lo
      cursor += 2
    } else {
      events[cursor] = KIND_ADD_LINK
    }
    events[cursor + 1] = targetSpanId.hi
    events[cursor + 2] = targetSpanId.lo
    events[cursor + 3] = attributesId
    this.#eventCursor = cursor + 4
  }

  /**
   * `[nameId, timeHi, timeLo, attrsId]`, or the explicit-id form.
   *
   * @param {import('./span_context')} context
   * @param {string} name
   * @param {number} timeMillis
   * @param {string} serializedAttributes
   */
  addEvent (context, name, timeMillis, serializedAttributes) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const explicit = this.#enterContext(context)
    const nameId = this.#intern(name)
    const attributesId = this.#intern(serializedAttributes)

    splitMillisToNanoLanes(timeMillis)

    const events = this.#events
    let cursor = this.#eventCursor
    if (explicit) {
      const spanId = context._spanId
      events[cursor] = KIND_ADD_EVENT_ID
      events[cursor + 1] = spanId.hi
      events[cursor + 2] = spanId.lo
      cursor += 2
    } else {
      events[cursor] = KIND_ADD_EVENT
    }
    events[cursor + 1] = nameId
    events[cursor + 2] = LANES[0]
    events[cursor + 3] = LANES[1]
    events[cursor + 4] = attributesId
    this.#eventCursor = cursor + 5
  }

  /**
   * `[durationHi, durationLo]`, or the explicit-id form. No follow-up write and
   * no `LEAVE_CONTEXT`: `#enteredContext` holds an object reference, so a stale
   * one can only ever match the very span it already refers to.
   *
   * @param {import('./span_context')} context
   * @param {number} startHi Start-time lanes, kept by the span since the
   * duration has to be a lane-wise subtraction rather than a float difference.
   * @param {number} startLo
   * @param {number} finishMillis
   */
  finish (context, startHi, startLo, finishMillis) {
    if (this.#eventCursor >= EVENT_LIMIT) this.flush()

    const explicit = this.#enterContext(context)

    splitMillisToNanoLanes(finishMillis)
    subtractNanoLanes(startHi, startLo, LANES[0], LANES[1])

    const events = this.#events
    let cursor = this.#eventCursor
    if (explicit) {
      const spanId = context._spanId
      events[cursor] = KIND_FINISH_ID
      events[cursor + 1] = spanId.hi
      events[cursor + 2] = spanId.lo
      cursor += 2
    } else {
      events[cursor] = KIND_FINISH
    }
    events[cursor + 1] = LANES[0]
    events[cursor + 2] = LANES[1]
    this.#eventCursor = cursor + 3
  }

  /**
   * The whole start of a web-server request in one record.
   *
   * A generic span of the same shape costs a `SPAN_START`, a context entry and eight or
   * nine `SET_TAG_STRING`s — roughly 42 words plus the interning for every key. This is
   * 11, because a web request's shape is known: its span kind is always `server`, its
   * type is always `web`, and its name, `component` and `_dd.integration` all follow
   * from the framework id sent at finish. Only the method and the URL are genuinely
   * per-request, and no tag *keys* travel at all — position carries the meaning.
   *
   * The segment is opened separately, by `segmentStart`, rather than implied here: a web
   * request roots its own segment today, but an inferred proxy span would sit above it in
   * the same segment and this record must not have to change for that.
   *
   * @param {import('./span_context')} context
   * @param {number} startHi Start time in integer-nanosecond lanes.
   * @param {number} startLo
   * @param {string} method
   * @param {string} url
   */
  webRequestStart (context, startHi, startLo, method, url) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const methodId = this.#intern(method)
    const urlId = this.#intern(url)

    const segmentId = context._segmentId
    const spanId = context._spanId
    const parentId = context._parentId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_WEB_REQUEST_START
    events[cursor + 1] = segmentId.hi
    events[cursor + 2] = segmentId.lo
    events[cursor + 3] = spanId.hi
    events[cursor + 4] = spanId.lo
    events[cursor + 5] = parentId.hi
    events[cursor + 6] = parentId.lo
    events[cursor + 7] = startHi
    events[cursor + 8] = startLo
    events[cursor + 9] = methodId
    events[cursor + 10] = urlId
    this.#eventCursor = cursor + 11

    this.#lastExplicitContext = context
    this.#pendingContext = context
  }

  /**
   * The rest of a web-server request: duration, the response status, the matched
   * route and which framework handled it. Always carries its own id — a request
   * finishes long after its middleware have come and gone, so the entered context
   * is rarely still this span and the elided form would seldom apply.
   *
   * @param {import('./span_context')} context
   * @param {number} startHi
   * @param {number} startLo
   * @param {number} finishMillis
   * @param {number} statusCode
   * @param {string} route Empty when nothing matched.
   * @param {number} framework One of `FRAMEWORK_*` in `./wire`.
   */
  webRequestFinish (context, startHi, startLo, finishMillis, statusCode, route, framework) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const routeId = this.#intern(route)

    splitMillisToNanoLanes(finishMillis)
    subtractNanoLanes(startHi, startLo, LANES[0], LANES[1])

    const spanId = context._spanId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_WEB_REQUEST_FINISH
    events[cursor + 1] = spanId.hi
    events[cursor + 2] = spanId.lo
    events[cursor + 3] = LANES[0]
    events[cursor + 4] = LANES[1]
    events[cursor + 5] = statusCode
    events[cursor + 6] = routeId
    events[cursor + 7] = framework
    this.#eventCursor = cursor + 8

    this.#lastExplicitContext = context
    this.#pendingContext = context
  }

  /**
   * A middleware span in one record.
   *
   * The generic equivalent is a `SPAN_START` plus four tags — the operation name, the
   * resource, `component` and `_dd.integration` — around 24 words and five interning
   * lookups. This is 11 words and one lookup, because only the handler name varies: the
   * name and both tags follow from the framework word, and a middleware span has no type
   * and no span kind. There is no specialized finish; a plain `FINISH` already carries
   * nothing but the duration.
   *
   * @param {import('./span_context')} context
   * @param {number} startHi
   * @param {number} startLo
   * @param {string} resource The handler's name, or `<anonymous>`.
   * @param {number} framework One of `MIDDLEWARE_*` in `./wire`.
   */
  middlewareStart (context, startHi, startLo, resource, framework) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const resourceId = this.#intern(resource)

    const segmentId = context._segmentId
    const spanId = context._spanId
    const parentId = context._parentId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_MIDDLEWARE_START
    events[cursor + 1] = segmentId.hi
    events[cursor + 2] = segmentId.lo
    events[cursor + 3] = spanId.hi
    events[cursor + 4] = spanId.lo
    events[cursor + 5] = parentId.hi
    events[cursor + 6] = parentId.lo
    events[cursor + 7] = startHi
    events[cursor + 8] = startLo
    events[cursor + 9] = resourceId
    events[cursor + 10] = framework
    this.#eventCursor = cursor + 11

    this.#lastExplicitContext = context
    this.#pendingContext = context
  }

  /**
   * `[idHi, idLo, messageId, typeId, stackId]` — one record for a failed span, of any
   * kind.
   *
   * This replaces the four records `setTag('error', err)` used to write: three
   * `SET_TAG_STRING`s and a `SET_TAG_NUMBER` for the flag, which the assembler now infers
   * from this record existing. Errors are rare, so nothing about them is folded into the
   * finish records that every span writes.
   *
   * @param {import('./span_context')} context
   * @param {string} message
   * @param {string} type
   * @param {string} stack
   */
  spanError (context, message, type, stack) {
    if (this.#eventCursor >= EVENT_LIMIT || this.#stringCursor >= STRING_LIMIT) this.flush()

    const messageId = this.#intern(message)
    const typeId = this.#intern(type)
    const stackId = this.#intern(stack)

    const spanId = context._spanId
    const events = this.#events
    const cursor = this.#eventCursor

    events[cursor] = KIND_SPAN_ERROR
    events[cursor + 1] = spanId.hi
    events[cursor + 2] = spanId.lo
    events[cursor + 3] = messageId
    events[cursor + 4] = typeId
    events[cursor + 5] = stackId
    this.#eventCursor = cursor + 6

    this.#lastExplicitContext = context
    this.#pendingContext = context
  }

  /**
   * Hand the three buffers to Rust — decode, chunk assembly and msgpack encoding all
   * run inline, on this thread, before the call returns; only the HTTP PUT is
   * deferred. Cursors and the interning table reset afterwards, so the next
   * window starts overwriting from the front of each buffer with ids restarting
   * at `FIRST_DYNAMIC_STRING_ID`.
   */
  flush () {
    if (this.#eventCursor === 0) return

    try {
      this.#flusher.flush(this.#eventCursor, this.#doubleCursor, this.#stringCursor)
    } catch (error) {
      log.error('Native span flush failed', error)
    }

    this.#eventCursor = 0
    this.#doubleCursor = 0
    this.#stringCursor = 0

    this.#stringMap = new Map(RESERVED_ENTRIES)
    this.#nextStringId = FIRST_DYNAMIC_STRING_ID

    // Decode carries the entered-state per batch, so the next batch starts from
    // "nothing entered" and every context has to prove locality again.
    this.#enteredContext = undefined
    this.#pendingContext = undefined
    this.#lastExplicitContext = undefined
  }

  /**
   * The adaptive-entry decision. Bracketing is only paid once a repeat is proven
   * by the immediately preceding write, which makes the worst case — never
   * touching the same span twice in a row — an exact tie with always writing the
   * id, rather than a regression.
   *
   * @param {import('./span_context')} context
   * @returns {boolean} Whether this record must carry the id lanes.
   */
  #enterContext (context) {
    let explicit = false

    if (context !== this.#enteredContext) {
      if (context === this.#pendingContext) {
        // Second touch in a row — now worth entering.
        const events = this.#events
        const cursor = this.#eventCursor
        if (context === this.#lastExplicitContext) {
          events[cursor] = KIND_ENTER_CONTEXT_KEEP_LAST
          this.#eventCursor = cursor + 1
        } else {
          const spanId = context._spanId
          events[cursor] = KIND_ENTER_CONTEXT_NEW
          events[cursor + 1] = spanId.hi
          events[cursor + 2] = spanId.lo
          this.#eventCursor = cursor + 3
        }
        this.#enteredContext = context
      } else {
        // First touch, no proven locality yet — plain explicit id.
        this.#lastExplicitContext = context
        explicit = true
      }
    }

    this.#pendingContext = context

    return explicit
  }

  /**
   * Resolve `value` to an id valid for the current flush window, registering it
   * if this window has not seen it yet. Reserved strings are pre-seeded into the
   * table, so the universal keys cost one `Map` hit and never any wire traffic.
   *
   * @param {string} value
   * @returns {number}
   */
  #intern (value) {
    const existing = this.#stringMap.get(value)
    if (existing !== undefined) return existing

    const stringId = this.#nextStringId++
    this.#stringMap.set(value, stringId)

    const byteLength = this.#strings.utf8Write(value, this.#stringCursor, MAX_STRING_BYTES)
    this.#stringCursor += byteLength

    const events = this.#events
    const cursor = this.#eventCursor
    events[cursor] = KIND_REGISTER_STRING
    events[cursor + 1] = stringId
    events[cursor + 2] = byteLength
    this.#eventCursor = cursor + 3

    return stringId
  }
}

// `SET_TAG_NUMBER` is the only float-carrying kind today; the assertion is here
// so adding a second one fails loudly at load time unless the record's own word
// layout drops the value, which is the whole point of the shared buffer.
/* istanbul ignore if */
if (DOUBLE_COUNTS[KIND_SET_TAG_NUMBER] !== 1) {
  throw new Error('native-spans: SET_TAG_NUMBER must consume exactly one double')
}

/**
 * `DD_NATIVE_SPANS_WRITE=0` drops every record on the floor, leaving the span layer
 * above it — id generation, timestamp splitting, tag dispatch, link and event
 * serialization — fully intact. Subtracting this from a normal run prices the buffer
 * traffic and the interning table on their own.
 *
 * Overriding the write methods rather than branching inside them keeps the flag off
 * the hot path entirely: with it on, `EventWriter` is byte for byte the class it was. The
 * cost is that a write method added to `EventWriter` without an override here would
 * quietly keep writing — which is exactly what happened when the web-server events
 * landed — so `test/native-spans/event-writer.spec.js` pins the two method sets equal.
 * Nothing is written, so `flush()` has nothing to hand over and the whole Rust
 * pipeline goes quiet too — this is the JS-side counterpart of
 * `DD_NATIVE_SPANS_DECODE=0`, and the outermost rung of that same ladder.
 *
 * Deliberately read straight from the environment instead of through
 * `config/helper`, like the four Rust-side stage flags: these are development
 * instrumentation, and registering them in `supported-configurations.json` would
 * publish them as product configuration and put them in the generated config types.
 */
class NoopEventWriter extends EventWriter {
  segmentStart () {}

  spanStart () {}

  setTagString () {}

  setTagNumber () {}

  addLink () {}

  addEvent () {}

  middlewareStart () {}

  spanError () {}

  finish () {}

  webRequestStart () {}

  webRequestFinish () {}

  flush () {}
}

// Development stage flag, not configuration — see the note on `NoopEventWriter`.
// eslint-disable-next-line eslint-rules/eslint-process-env
const WRITES_DISABLED = isFalse(process.env.DD_NATIVE_SPANS_WRITE ?? 'true')

/**
 * `config.tags` as one string: `key\tvalue\nkey\tvalue`. Tab and newline are the
 * separators because no real tag key or value contains either, and it keeps the parse on
 * the Rust side to two `split` calls with no escaping.
 *
 * @param {Record<string, unknown> | undefined} tags
 * @returns {string}
 */
function serializeProcessTags (tags) {
  if (tags === undefined || tags === null) return ''
  let out = ''
  for (const key of Object.keys(tags)) {
    const value = tags[key]
    if (typeof value !== 'string' && typeof value !== 'number') continue
    if (out !== '') out += '\n'
    out += `${key}\t${value}`
  }
  return out
}

/** @type {EventWriter | undefined} */
let writer

/**
 * The process-wide writer. One set of buffers, so the span and span-context
 * modules reach it here rather than each context holding a reference to it.
 *
 * @param {Config} [config] Required on the first call, which is the tracer's.
 * @returns {EventWriter}
 */
function getWriter (config) {
  writer ??= WRITES_DISABLED ? new NoopEventWriter(config) : new EventWriter(config)
  return writer
}

module.exports = { EventWriter, NoopEventWriter, getWriter }
