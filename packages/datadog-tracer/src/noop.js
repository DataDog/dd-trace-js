'use strict'

class NoopTracer {
  startSpan () { return noopSpan }
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

const noopSpan = new NoopSpan()

module.exports = { NoopSpan, NoopTracer }
