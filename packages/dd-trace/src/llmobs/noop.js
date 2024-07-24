'use strict'

class NoopLLMObs {
  constructor () {
    this._config = {}
    this._tracer = {}
  }

  enable (options) {}

  disable () {}

  annotate (span, options) {}

  exportSpan (span) {}

  submitEvaluation (llmobsSpanContext, options) {}

  startSpan (kind, options) {}

  trace (kind, options, fn) {}

  wrap (kind, options, fn) {}
}

module.exports = NoopLLMObs
