'use strict'

const { channel } = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const { enterRoute } = require('../../../../datadog-plugin-router/src/route')
const web = require('../../plugins/util/web')
const { LANES, nowMillis, splitMillisToNanoLanes } = require('../clock')
const { getWriter } = require('../event-writer')
const { randomId } = require('../id')
const NativeSpanContext = require('../span_context')

const legacyStorage = storage('legacy')

/**
 * A middleware span with no `Span` object.
 *
 * These are the highest-volume spans a web app produces — an express request runs through
 * several layers, and each one is a span whose shape never varies: no type, no span kind,
 * a `component` and `_dd.integration` pair fixed per framework, and an operation name that
 * is just `<framework>.middleware`. The only per-layer value is the handler's name.
 *
 * So one 11-word record replaces a `SPAN_START` plus four tags — around 24 words and five
 * interning lookups — and the finish reuses the plain `FINISH`, which already carries
 * nothing but a duration.
 *
 * Route accumulation is *not* reimplemented here: `enterRoute` is the router plugin's own
 * logic, extracted so both callers share it. The route is still published through
 * `web.setRoute`, which is where the web-server plugin reads it from.
 */
class NativeMiddlewarePlugin {
  /** Per-request state, keyed by the request like the router plugin's own contexts. */
  #requests = new WeakMap()
  #subscriptions = []
  #enabled = false
  #config = {}

  /**
   * @param {string} id The dispatching host: `router` or `express`.
   * @param {number} framework One of `MIDDLEWARE_*` in `../wire`.
   */
  constructor (id, framework) {
    this.#framework = framework

    this.#on(channel(`apm:${id}:middleware:enter`), message => this.#enter(message))
    this.#on(channel(`apm:${id}:middleware:next`), ({ req }) => {
      // A layer that calls `next` gives its path segment back.
      this.#requests.get(req)?.stack.pop()
    })
    this.#on(channel(`apm:${id}:middleware:finish`), ({ req }) => this.#finish(req))
    this.#on(channel(`apm:${id}:middleware:exit`), ({ req }) => this.#exit(req))
    this.#on(channel(`apm:${id}:middleware:error`), ({ req, error }) => this.#error(req, error))
    // `apm:${id}:middleware:repeat` is deliberately not handled. When a layer calls `next`
    // twice its own span has already finished, so the generic plugin records a
    // `middleware.next_called_again` event on the request span instead. Writing that here
    // is a two-line change — `state.parent` is what `web.root(req)` resolves to — but no
    // repro was found that makes the channel fire at all, including on the baseline, so it
    // would ship unverified. That is the same shape as the bug on the line below, where a
    // subscription silently never fired; an unexercised handler is worse than a known gap.
    //
    // Not per-host: the request-level channel is the http server's, whatever dispatched
    // the layers. Subscribing to `apm:${id}:request:finish` silently never fired, which
    // left every middleware span open and every server trace unexported.
    this.#on(channel('apm:http:server:request:finish'), ({ req }) => this.#finishAll(req))
  }

  #framework

  /**
   * @param {import('dc-polyfill').Channel} target
   * @param {(message: object) => void} handler
   */
  #on (target, handler) {
    this.#subscriptions.push({ target, handler })
  }

  /**
   * @param {boolean | { enabled?: boolean, middleware?: boolean }} config
   */
  configure (config) {
    this.#config = typeof config === 'boolean' ? { enabled: config } : (config ?? {})
    const enabled = this.#config.enabled !== false
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
   * @param {{ req: object, name: string, route: string }} message
   */
  #enter ({ req, name, route }) {
    const store = legacyStorage.getStore()
    let state = this.#requests.get(req)

    // The parent is the innermost middleware still open, or whatever was active when the
    // request reached the first layer.
    let parent
    if (state === undefined) {
      parent = store?.span
      if (parent === undefined || parent._spanId === undefined) return
      state = { stack: [], route: '', open: [], stores: [], parent }
      this.#requests.set(req, state)
    } else {
      parent = state.open.length === 0 ? state.parent : state.open.at(-1).context
    }

    web.setRoute(req, enterRoute(state, route))

    // `middleware: false` keeps the route bookkeeping and skips the spans, matching the
    // router plugin, whose `#getMiddlewareSpan` returns the parent unchanged.
    if (this.#config.middleware === false) {
      state.stores.push(store)
      return
    }

    const startMillis = nowMillis()
    splitMillisToNanoLanes(startMillis)
    const startHi = LANES[0]
    const startLo = LANES[1]

    const context = new NativeSpanContext(
      parent._traceId,
      parent._segmentId,
      randomId(),
      parent._spanId
    )

    getWriter().middlewareStart(context, startHi, startLo, name || '<anonymous>', this.#framework)

    state.open.push({ context, startHi, startLo })
    state.stores.push(store)
    web.patch(req)
    legacyStorage.enterWith({ ...store, span: context })
  }

  /**
   * @param {object} req
   */
  #finish (req) {
    const state = this.#requests.get(req)
    if (state === undefined || state.open.length === 0) return
    this.#finishOne(state.open.pop())
  }

  /**
   * @param {object} req
   */
  #exit (req) {
    const state = this.#requests.get(req)
    if (state === undefined) return
    const store = state.stores.pop()
    legacyStorage.enterWith(store)
  }

  /**
   * @param {object} req
   * @param {Error} error
   */
  #error (req, error) {
    web.addError(req, error)

    const state = this.#requests.get(req)
    if (state === undefined || state.open.length === 0 || !(error instanceof Error)) return

    getWriter().spanError(
      state.open.at(-1).context,
      error.message ?? '',
      error.name ?? '',
      error.stack ?? ''
    )
  }

  /**
   * The request ended; anything still open never reached its own finish.
   *
   * @param {object} req
   */
  #finishAll (req) {
    const state = this.#requests.get(req)
    if (state === undefined) return
    let open
    while ((open = state.open.pop()) !== undefined) {
      this.#finishOne(open)
    }
  }

  /**
   * @param {{ context: object, startHi: number, startLo: number }} open
   */
  #finishOne ({ context, startHi, startLo }) {
    getWriter().finish(context, startHi, startLo, nowMillis())
  }
}

module.exports = NativeMiddlewarePlugin
