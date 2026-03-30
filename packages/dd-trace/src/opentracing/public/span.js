'use strict'

const { SVC_SRC_KEY } = require('../../constants')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  // A WeakMap cache ensures the same wrapper instance is returned for the same
  // underlying span, so reference equality checks (===) in user code remain stable.
  static #cache = new WeakMap()

  constructor (span) {
    if (span instanceof PublicSpan) {
      return span
    }
    const cached = PublicSpan.#cache.get(span)
    if (cached !== undefined) {
      return cached
    }
    this._span = span
    PublicSpan.#cache.set(span, this)
  }

  setTag (key, value) {
    if (key === SERVICE_KEY || key === SERVICE_NAME_KEY) {
      this._span.setTag(SVC_SRC_KEY, 'm')
    }
    this._span.setTag(key, value)
    return this
  }

  addTags (tags) {
    if (tags[SERVICE_KEY] || tags[SERVICE_NAME_KEY]) {
      this._span.setTag(SVC_SRC_KEY, 'm')
    }
    this._span.addTags(tags)
    return this
  }
}

// Whenever a method needs to be modified to have a unique public behavior, it
// should be removed from this list.
for (const method of [
  'context',
  'tracer',
  'setOperationName',
  'setBaggageItem',
  'getBaggageItem',
  'getAllBaggageItems',
  'removeBaggageItem',
  'removeAllBaggageItems',
  'log',
  'logEvent',
  'addLink',
  'addLinks',
  'addSpanPointer',
  'addEvent',
  'finish',
  'toString',
]) {
  PublicSpan.prototype[method] = function (...args) {
    const result = this._span[method](...args)
    // always return wrapper span when the result is the span itself
    return result === this._span ? this : result
  }
}

module.exports = PublicSpan
