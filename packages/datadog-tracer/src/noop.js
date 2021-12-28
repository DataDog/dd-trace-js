'use strict'

class NoopTracer {
  startSpan () { return span }
  inject () {}
  extract () { return null }
  export () {}
  flush () {}
}

class NoopSpan {
  setTag () {}
  addTags () {}
  addError () {}
  sample () {}
  finish () {}
}

const span = new NoopSpan()
const tracer = new NoopTracer()

module.exports = { tracer }
