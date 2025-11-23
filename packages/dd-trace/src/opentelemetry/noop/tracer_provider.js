'use strict'

const noopSpan = {
  spanContext: () => ({}),
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  updateName: () => {},
  setStatus: () => {},
  end: () => {},
  isRecording: () => false
}

const noopTracer = {
  startSpan: () => noopSpan,
  startActiveSpan: () => noopSpan,
}

const noopSpanProcessor = {
  onStart: () => {},
  onEnd: () => {},
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve()
}

class NoopTracerProvider {
  constructor (config = {}) {
    this.config = config
    this.resource = config.resource
    this._processors = []
  }

  getTracer () {
    return noopTracer
  }

  addSpanProcessor () {
    // No-op
  }

  getActiveSpanProcessor () {
    return noopSpanProcessor
  }

  register () {
    // No-op
  }

  forceFlush () {
    // No-op
  }

  shutdown () {
    // No-op
  }
}

module.exports = NoopTracerProvider
