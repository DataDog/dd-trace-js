'use strict'

class NoopLLMObs {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  get enabled () {
    return false
  }

  enable (options) {}

  disable () {}

  annotate (span, options) {}

  exportSpan (span) {}

  submitEvaluation (llmobsSpanContext, options) {}

  startSpan (kind, options) {
    return this._tracer.startSpan(kind, options)
  }

  trace (kind, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return

    options = options || {}

    return this._tracer.trace(kind, options, fn)
  }

  wrap (kind, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}

    return this._tracer.wrap(kind, options, fn)
  }

  decorate (kind, options) {
    const llmobs = this
    return function (target) {
      return llmobs.wrap(kind, options, target)
    }
  }

  flush () {}
}

module.exports = NoopLLMObs
