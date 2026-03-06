'use strict'

const Scope = require('../noop/scope')
const Span = require('./span')

class NoopTracer {
  #scope
  #span

  constructor (config) {
    this.#scope = new Scope()
    this.#span = new Span(this)
  }

  configure (options) {}

  trace (name, options, fn) {
    return fn(this.#span, () => {})
  }

  wrap (name, options, fn) {
    return fn
  }

  scope () {
    return this.#scope
  }

  getRumData () {
    return ''
  }

  setUrl () {}

  startSpan (name, options) {
    return this.#span
  }

  inject (spanContext, format, carrier) {}

  extract (format, carrier) {
    return this.#span.context()
  }

  setUser () {
    return this
  }
}

module.exports = NoopTracer
