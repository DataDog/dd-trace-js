'use strict'

const NoopSpanContext = require('./span_context')
const id = require('../id')
const { storage } = require('../../../datadog-core') // TODO: noop storage?

class NoopSpan {
  constructor (tracer, parent) {
    this._store = storage.getStore()
    this._noopTracer = tracer
    this._noopContext = this._createContext(parent)
  }

  context () { return this._noopContext }
  tracer () { return this._noopTracer }
  setOperationName (name) { return this }
  setBaggageItem (key, value) { return this }
  getBaggageItem (key) {}
  setTag (key, value) { return this }
  addTags (keyValueMap) { return this }
  log () { return this }
  logEvent () {}
  finish (finishTime) {}

  _createContext (parent) {
    const spanId = id()

    if (parent) {
      return new NoopSpanContext({
        noop: this,
        traceId: parent._traceId,
        spanId,
        parentId: parent._spanId,
        baggageItems: Object.assign({}, parent._baggageItems)
      })
    } else {
      return new NoopSpanContext({
        noop: this,
        traceId: spanId,
        spanId
      })
    }
  }
}

module.exports = NoopSpan
