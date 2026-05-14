'use strict'

const { markManualService } = require('./service-source')
const { PublicSpan, unwrap } = require('./span')
const { setPublicTracer } = require('./tracer-ref')

/**
 * Public wrapper around the internal tracer (NoopTracer or DatadogTracer).
 * Owns the wrap/unwrap boundary so PublicSpan never leaks past it and
 * internals never leak out through `span.tracer()`.
 *
 * Construction stamps the inner tracer so `PublicSpan.tracer()` can resolve
 * the facade for spans constructed outside `PublicTracer.startSpan` (e.g. in
 * `scope.js`, plugin hooks).
 */
class PublicTracer {
  #internalTracer

  constructor (tracer) {
    this.#internalTracer = tracer
    setPublicTracer(tracer, this)
  }

  startSpan (name, options) {
    options = markManualService(options)

    const childOf = unwrap(options?.childOf)

    if (childOf !== undefined) {
      options = { ...options, childOf }
    }

    return new PublicSpan(this.#internalTracer.startSpan(name, options))
  }

  trace (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn === 'function') {
      return this.#internalTracer.trace(name, markManualService(options || {}), fn)
    }
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    return this.#internalTracer.wrap(name, markManualService(options || {}), fn)
  }

  inject (context, format, carrier) {
    return this.#internalTracer.inject(unwrap(context), format, carrier)
  }

  extract () {
    return this.#internalTracer.extract.apply(this.#internalTracer, arguments)
  }

  scope () {
    return this.#internalTracer.scope.apply(this.#internalTracer, arguments)
  }

  setUrl () {
    this.#internalTracer.setUrl.apply(this.#internalTracer, arguments)
    return this
  }

  getRumData () {
    return this.#internalTracer.getRumData.apply(this.#internalTracer, arguments)
  }
}

module.exports = { PublicTracer }
