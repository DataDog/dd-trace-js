'use strict'

class NoopSpanProcessor {
  forceFlush () {
    return Promise.resolve()
  }

  onStart (span, context) { }
  onEnd (span) { }

  shutdown () {
    return Promise.resolve()
  }
}

class MultiSpanProcessor extends NoopSpanProcessor {
  constructor (spanProcessors) {
    super()
    this._processors = spanProcessors
  }

  forceFlush () {
    return Promise.all(
      this._processors.map(p => p.forceFlush())
    )
  }

  onStart (span, context) {
    for (const processor of this._processors) {
      processor.onStart(span, context)
    }
  }

  onEnd (span) {
    for (const processor of this._processors) {
      processor.onEnd(span)
    }
  }

  shutdown () {
    return Promise.all(
      this._processors.map(p => p.shutdown())
    )
  }
}

module.exports = {
  MultiSpanProcessor,
  NoopSpanProcessor
}
