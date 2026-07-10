'use strict'

class NoopSpanProcessor {
  forceFlush () {
    return Promise.resolve()
  }

  onStart (span, context) {}
  onEnd (span) {}

  shutdown () {
    return Promise.resolve()
  }
}

class MultiSpanProcessor extends NoopSpanProcessor {
  #processors

  constructor (spanProcessors) {
    super()
    this.#processors = spanProcessors
  }

  forceFlush () {
    return Promise.all(
      this.#processors.map(p => p.forceFlush())
    )
  }

  onStart (span, context) {
    for (const processor of this.#processors) {
      processor.onStart(span, context)
    }
  }

  onEnd (span) {
    for (const processor of this.#processors) {
      processor.onEnd(span)
    }
  }

  shutdown () {
    return Promise.all(
      this.#processors.map(p => p.shutdown())
    )
  }
}

module.exports = {
  MultiSpanProcessor,
  NoopSpanProcessor,
}
