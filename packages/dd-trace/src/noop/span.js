'use strict'

const NoopSpanContext = require('./span_context')
const DatadogSpanContext = require('../opentracing/span_context')
const id = require('../id')
const { storage } = require('../../../datadog-core') // TODO: noop storage?

class NoopSpan {
  constructor (tracer, parent, options = {}) {
    this._store = storage.getStore()
    this._noopTracer = tracer
    this._noopContext = this._createContext(parent, options)
    this._options = options
  }

  _getTime () {}

  context () { return this._noopContext }
  tracer () { return this._noopTracer }
  setOperationName (name) { return this }
  setBaggageItem (key, value) { return this }
  getBaggageItem (key) {}
  getAllBaggageItems () {}
  removeBaggageItem (key) { return this }
  removeAllBaggageItems () { return this }
  setTag (key, value) { return this }
  addTags (keyValueMap) { return this }
  addLink (link) { return this }
  addSpanPointer (ptrKind, ptrDir, ptrHash) { return this }
  log () { return this }
  logEvent () {}
  finish (finishTime) {}

  _createContext (parent, options) {
    const spanId = id()

    if (parent) {
      // necessary for trace level configuration. This pattern returns the first valid span context that is not a
      // NoopSpanContext, aka the next parent span in the trace that will be kept.
      if (options.keepParent && parent) {
        return parent instanceof DatadogSpanContext ? parent : parent.context()
      }

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
