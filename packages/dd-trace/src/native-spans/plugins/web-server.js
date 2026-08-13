'use strict'

const { channel } = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const web = require('../../plugins/util/web')
const { LANES, nowMillis, splitMillisToNanoLanes } = require('../clock')
const { getWriter } = require('../event-writer')
const { identifierToNativeId, randomId, traceIdFrom, traceIdFromRemote, ZERO_ID } = require('../id')
const NativeSpanContext = require('../span_context')
const { FRAMEWORK_EXPRESS, FRAMEWORK_HTTP } = require('../wire')

const legacyStorage = storage('legacy')

// The same channels the generic `http` server plugin and the express plugin subscribe
// to. Nothing about the instrumentation changes — only what happens on the other end.
const requestStart = channel('apm:http:server:request:start')
const requestExit = channel('apm:http:server:request:exit')
const requestFinish = channel('apm:http:server:request:finish')
const requestError = channel('apm:http:server:request:error')
const expressHandle = channel('apm:express:request:handle')
// A framework that catches handler errors and routes them to its own error middleware
// never reaches the http-level error channel, so the framework channels are the ones that
// carry a `/error`-style failure. `web.addError` is where the generic path stores it.
// Both hosts are needed: the router instrumentation names its channels after whichever
// host dispatched the layer, and an express app's own layers dispatch as `router`.
const middlewareErrorChannels = [
  channel('apm:express:middleware:error'),
  channel('apm:router:middleware:error'),
]

/**
 * A web-server span with no `Span` object anywhere in it.
 *
 * The generic path is: instrumentation publishes a message, the plugin allocates a
 * `Span`, and then re-states through `setTag` what its own shape already implies —
 * `span.kind` is `server` on every web request, the type is always `web`, the component
 * never varies for a given framework, and every tag arrives as a key *and* a value even
 * though the key is the same on every call.
 *
 * This writes two records instead. Position carries the meaning, so no tag key is ever
 * sent; the framework is one word from which the operation name, `component` and
 * `_dd.integration` all follow; and the span kind, type, `_dd.measured` and the
 * process-level service / env / version are not sent at all because they are the same on
 * every web request. Rust puts them back — see `expand_web_request` in `process.rs`.
 *
 * What still exists is a `NativeSpanContext`: four ids, no tags. Child spans need
 * something to attach to, and `scope().active()` needs something to return, so the
 * context goes into the async-local store exactly as the generic plugin's span would.
 * Middleware spans therefore still work, and still come out as children.
 */
class NativeWebServerPlugin {
  static id = 'http'

  /** Per-request state, keyed by the request object like `web.js`'s own contexts. */
  #requests = new WeakMap()
  /** The same state reached from its context, for the error channel (see `#error`). */
  #byContext = new WeakMap()
  #subscriptions = []
  #enabled = false

  #tracer

  /**
   * @param {import('../../opentracing/tracer')} tracer Used only to extract incoming
   * propagation; no span is ever started through it.
   */
  constructor (tracer) {
    this.#tracer = tracer

    this.#on(requestStart, message => this.#start(message))
    this.#on(requestExit, message => this.#exit(message))
    this.#on(requestFinish, message => this.#finish(message))
    this.#on(requestError, error => this.#error(error))
    this.#on(expressHandle, ({ req }) => {
      const state = this.#requests.get(req)
      if (state !== undefined) state.framework = FRAMEWORK_EXPRESS
    })
    for (const target of middlewareErrorChannels) {
      this.#on(target, ({ req, error }) => {
        if (!(error instanceof Error)) return
        const state = this.#requests.get(req)
        if (state !== undefined) this.#recordError(state, error)
      })
    }
  }

  /**
   * @param {import('dc-polyfill').Channel} target
   * @param {(message: unknown) => void} handler
   */
  #on (target, handler) {
    this.#subscriptions.push({ target, handler })
  }

  /**
   * The plugin manager's contract: `configure({ enabled })`.
   *
   * @param {boolean | { enabled?: boolean }} config
   */
  configure (config) {
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    if (enabled === this.#enabled) return
    this.#enabled = enabled

    for (const { target, handler } of this.#subscriptions) {
      if (enabled) {
        target.subscribe(handler)
      } else {
        target.unsubscribe(handler)
      }
    }
  }

  /**
   * @param {{ req: object, res: object }} message
   */
  #start ({ req, res }) {
    const writer = getWriter()
    const startMillis = nowMillis()

    splitMillisToNanoLanes(startMillis)
    const startHi = LANES[0]
    const startLo = LANES[1]

    // A server request always roots its own segment, but not necessarily its own trace:
    // an incoming caller's context makes it a child, and the trace id then comes from the
    // caller. `extract` returns the baseline's `SpanContext`, whose ids are byte buffers.
    const spanId = randomId()
    const remote = this.#extract(req)
    const context = new NativeSpanContext(
      remote === null ? traceIdFrom(spanId, startMillis) : traceIdFromRemote(remote),
      spanId,
      spanId,
      remote === null ? ZERO_ID : identifierToNativeId(remote._spanId)
    )

    // The segment is opened explicitly. A web request roots its own segment today, but
    // nothing in the wire format assumes it: an inferred proxy span above it would open
    // the segment instead and this call would move there.
    writer.segmentStart(context)
    writer.webRequestStart(context, startHi, startLo, req.method, url(req))

    const parentStore = legacyStorage.getStore()
    const state = {
      context,
      res,
      startHi,
      startLo,
      parentStore,
      framework: FRAMEWORK_HTTP,
      errorMessage: '',
      errorType: '',
      errorStack: '',
      finished: false,
    }
    this.#requests.set(req, state)
    this.#byContext.set(context, state)

    // The context stands in for the span in the store, so `scope().active()` returns it
    // and child spans find a parent. `startSpan` accepts a bare span context as
    // `childOf`, so nothing above here needs to know a span was never created.
    legacyStorage.enterWith({ ...parentStore, span: context })
  }

  /**
   * @param {object} req
   * @returns {object | null} The caller's span context, or `null` when the request
   * carries no propagation headers.
   */
  #extract (req) {
    const extracted = this.#tracer?.extract('http_headers', req.headers)
    return extracted?._traceId === undefined ? null : extracted
  }

  /**
   * @param {{ req: object }} message
   */
  #exit ({ req }) {
    const state = this.#requests.get(req)
    if (state === undefined) return
    legacyStorage.enterWith(state.parentStore)
  }

  /**
   * The instrumentation publishes the error with no request attached, so the active
   * context identifies which request it belongs to.
   */
  /**
   * @param {Error} error
   */
  #error (error) {
    const active = legacyStorage.getStore()?.span
    const state = active === undefined ? undefined : this.#byContext.get(active)
    if (state !== undefined) this.#recordError(state, error)
  }

  /**
   * @param {{ errorMessage: string, errorType: string }} state
   * @param {Error} error
   */
  #recordError (state, error) {
    // First error wins, matching `web.addError`, which only ever assigns.
    if (state.errorMessage !== '') return
    state.errorMessage = error?.message ?? String(error ?? '')
    state.errorType = error?.name ?? ''
    state.errorStack = error?.stack ?? ''
  }

  /**
   * @param {{ req: object }} message
   */
  #finish ({ req }) {
    const state = this.#requests.get(req)
    if (state === undefined || state.finished) return
    state.finished = true

    const writer = getWriter()

    // Only a request that actually failed writes the error strings. A 5xx without a
    // thrown error needs nothing here — the assembler reads that off the status.
    if (state.errorMessage !== '' || state.errorType !== '') {
      writer.spanError(state.context, state.errorMessage, state.errorType, state.errorStack)
    }

    writer.webRequestFinish(
      state.context,
      state.startHi,
      state.startLo,
      nowMillis(),
      state.res.statusCode ?? 0,
      route(req),
      state.framework
    )
  }
}

/**
 * The matched route, as the framework plugin computed it.
 *
 * Accumulating it here instead would mean reimplementing the router plugin's
 * specificity rules — a per-layer stack that joins, pops on `next`, and keeps the most
 * specific result. That plugin already does it and publishes the answer through
 * `web.setRoute`, so this reads the answer rather than deriving a second one that could
 * disagree. The consequence is that routes depend on the framework plugin being enabled;
 * the specialized events cover the server span, not route resolution.
 *
 * @param {object} req
 * @returns {string} Empty when nothing matched.
 */
function route (req) {
  const paths = web.getContext(req)?.paths
  if (paths === undefined || paths.length === 0) return ''
  // `web.js`'s own derivation: `paths[0]` covers the empty and single-segment cases.
  return (paths.length > 1 ? paths.join('') : paths[0]) || ''
}

/**
 * `web.js`'s `extractURL`, minus the parts this PoC does not cover (no `unix:` sockets,
 * no query-string obfuscation config).
 *
 * @param {{ headers: Record<string, string>, url: string, socket?: object }} req
 * @returns {string}
 */
function url (req) {
  const protocol = req.socket?.encrypted ? 'https' : 'http'
  return `${protocol}://${req.headers.host}${req.url}`
}

module.exports = NativeWebServerPlugin
