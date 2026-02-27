'use strict'

const noopSpan = {
  spanContext: () => ({}),
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  updateName: () => {},
  setStatus: () => {},
  end: () => {},
  isRecording: () => false,
}

const noopTracer = {
  startSpan: () => noopSpan,
  startActiveSpan: () => noopSpan,
}

const noopSpanProcessor = {
  onStart: () => {},
  onEnd: () => {},
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
}

class NoopTracerProvider {
  constructor (config = {}) {
    this.config = config
    this.resource = config.resource
  }

  getTracer () {
    return noopTracer
  }

  addSpanProcessor () {}

  getActiveSpanProcessor () {
    return noopSpanProcessor
  }

  register () {}

  forceFlush () {}

  shutdown () {}
}

module.exports = NoopTracerProvider
