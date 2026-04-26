'use strict'

const { SVC_SRC_KEY } = require('../../constants')
const { createPrivateMap } = require('../../util')
const DatadogSpan = require('../span')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'

const cache = createPrivateMap('dd.publicSpan')

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  constructor (span) {
    const cached = cache.get(span)
    if (cached) return cached

    this._span = span
    cache.set(span, this)
  }

  setTag (key, value) {
    if (key === SERVICE_KEY || key === SERVICE_NAME_KEY) {
      this._span.setTag(SVC_SRC_KEY, 'm')
    }
    this._span.setTag(key, value)
    return this
  }

  addTags (tags) {
    if (tags && (tags[SERVICE_KEY] || tags[SERVICE_NAME_KEY])) {
      this._span.setTag(SVC_SRC_KEY, 'm')
    }
    this._span.addTags(tags)
    return this
  }
}

// Whenever a method needs to be modified to have a unique public behavior, it
// should be implemented on `PublicSpan` directly so it is skipped here.
for (const method of Object.getOwnPropertyNames(DatadogSpan.prototype)) {
  if (method === 'constructor' || method.startsWith('_') || PublicSpan.prototype[method]) {
    continue
  }
  PublicSpan.prototype[method] = function (...args) {
    const result = this._span[method].apply(this._span, arguments)
    // always return wrapper span when the result is the span itself
    return result === this._span ? this : result
  }
}

module.exports = { PublicSpan }
