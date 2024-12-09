'use strict'

const NoopSpanContext = require('./span_context')
const id = require('../id')
const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const dateNow = Date.now
const { storage } = require('../../../datadog-core') // TODO: noop storage?

class NoopSpan {
  constructor (tracer, parent, options) {
    this._store = storage.getStore()
    this._noopTracer = tracer
    this._noopContext = this._createContext(parent, options)
    this._options = options
    this._startTime = this._getTime()
  }

  _getTime () {
    const startTime = dateNow() + now()

    return startTime
  }

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
  finish (finishTime) {
    const finish = finishTime ?? this._getTime()
    if (this._options.keepParent) {
      this._noopContext._tags[`operations.${this._options.metaIndex}.duration`] = finish - this._startTime
    }
  }

  _createContext (parent, options) {
    const spanId = id()

    if (parent) {
      if (options.keepParent) {
        return parent
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
