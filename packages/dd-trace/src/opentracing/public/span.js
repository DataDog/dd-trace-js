'use strict'

// A WeakMap cache at module scope ensures the same wrapper instance is returned
// for the same underlying span across all subclasses, so reference equality
// checks (===) in user code remain stable.
const cache = new WeakMap()

const { SVC_SRC_KEY } = require('../../constants')
const DatadogSpan = require('../span')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  constructor (span) {
    if (span instanceof PublicSpan) {
      return span
    }
    const cached = cache.get(span)
    if (cached !== undefined) {
      return cached
    }
    this._span = span
    try {
      cache.set(span, this)
    } catch {}
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
// should be implemented on `PublicSpan` directly so it is skipped here.
for (const method of Object.getOwnPropertyNames(DatadogSpan.prototype)) {
  if (method === 'constructor' || method.startsWith('_') || PublicSpan.prototype[method]) {
    continue
  }
  PublicSpan.prototype[method] = function (...args) {
    const result = this._span[method](...args)
    // always return wrapper span when the result is the span itself
    return result === this._span ? this : result
  }
}

module.exports = PublicSpan
