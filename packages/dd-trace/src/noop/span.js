'use strict'

const { storage } = require('../../../datadog-core') // TODO: noop storage?
const createSpanContext = require('../opentracing/create-span-context')
const NoopSpanContext = require('./span_context')

const legacyStorage = storage('legacy')
const noopProcessor = { sample () {} }

class NoopSpan {
  /**
   * @param {import('../opentracing/tracer')} tracer
   * @param {import('../opentracing/span_context') | null | undefined} parent
   */
  constructor (tracer, parent) {
    this._store = legacyStorage.getHandle()
    this._noopTracer = tracer
    this._noopContext = /** @type {NoopSpanContext} */ (createSpanContext(
      tracer._config, parent, undefined, tracer._traceId128BitGenerationEnabled, NoopSpanContext
    ))
    this._noopContext._noop = this
    this._spanContext = this._noopContext
    this._processor = noopProcessor
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
  addLinks (links) { return this }
  addSpanPointer (ptrKind, ptrDir, ptrHash) { return this }
  /**
   * @param {string} name
   * @param {import('../../../../index').SpanEventAttributes | number} [attributesOrStartTime]
   * @param {number} [startTime]
   */
  addEvent (name, attributesOrStartTime, startTime) { return this }
  /**
   * @param {import('../../../../index').Exception} exception
   * @param {import('../../../../index').SpanEventAttributes} [attributes]
   */
  recordException (exception, attributes) {}
  log () { return this }
  logEvent () {}
  finish (finishTime) {}
}

module.exports = NoopSpan
