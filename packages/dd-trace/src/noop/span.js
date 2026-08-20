'use strict'

const id = require('../id')
const { storage } = require('../../../datadog-core') // TODO: noop storage?
const { setSpanStore } = require('../opentracing/span-store')
const NoopSpanContext = require('./span_context')

const legacyStorage = storage('legacy')

class NoopSpan {
  constructor (tracer, parent) {
    setSpanStore(this, legacyStorage.getHandle())
    this._noopTracer = tracer
    this._noopContext = this._createContext(parent)
  }

  context () { return this._noopContext }
  tracer () { return this._noopTracer }
  setOperationName (name) { return this }

  /**
   * Preserve the DatadogSpan semantic mutation surface on non-recording spans.
   *
   * @param {string} name
   * @returns {NoopSpan}
   */
  setIntegrationName (name) { return this }

  /**
   * Preserve the DatadogSpan recording mutation surface on non-recording spans.
   *
   * @param {boolean} enabled
   * @returns {NoopSpan}
   */
  setRecording (enabled) { return this }

  setBaggageItem (key, value) { return this }
  getBaggageItem (key) {}
  getAllBaggageItems () {}
  removeBaggageItem (key) { return this }
  removeAllBaggageItems () { return this }
  setTag (key, value) { return this }

  /**
   * Report that a non-recording span did not retain the conditional tag.
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setTagIfAbsent (key, value) { return false }

  addTags (keyValueMap) { return this }

  /**
   * Report that a non-recording span did not retain conditional tags.
   *
   * @param {string} expectedKey
   * @param {unknown} expectedValue
   * @param {Record<string, unknown>} tags
   * @returns {boolean}
   */
  setTagsIfTagMatches (expectedKey, expectedValue, tags) { return false }

  addLink (link) { return this }
  addLinks (links) { return this }
  addSpanPointer (ptrKind, ptrDir, ptrHash) { return this }
  log () { return this }
  logEvent () {}
  finish (finishTime) {}

  _createContext (parent) {
    const spanId = id()

    return parent
      ? new NoopSpanContext({
        noop: this,
        traceId: parent._traceId,
        spanId,
        parentId: parent._spanId,
        baggageItems: { ...parent._baggageItems },
      })
      : new NoopSpanContext({
        noop: this,
        traceId: spanId,
        spanId,
      })
  }
}

module.exports = NoopSpan
