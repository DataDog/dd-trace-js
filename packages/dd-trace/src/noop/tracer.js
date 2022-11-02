'use strict'

const Scope = require('../noop/scope')
const Span = require('./span')

class NoopTracer {
  constructor (config) {
    this._scope = new Scope()
    this._span = new Span(this)
  }

  trace (name, options, fn) {
    return fn(this._span, () => {})
  }

  wrap (name, options, fn) {
    return fn
  }

  scope () {
    return this._scope
  }

  getRumData () {
    return ''
  }

  setUrl () {
  }

  startSpan (name, options) {
    return this._span
  }

  inject (spanContext, format, carrier) {}

  extract (format, carrier) {
    return this._span.context()
  }

  setUser () {
    return this
  }

  getLocalRootSpan(){
    return this
  }
}

module.exports = NoopTracer
