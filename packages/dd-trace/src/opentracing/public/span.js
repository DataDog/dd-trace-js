'use strict'

// A WeakMap cache at module scope ensures the same wrapper instance is returned
// for the same underlying span across all subclasses, so reference equality
// checks (===) in user code remain stable.
const cache = new WeakMap()

const { SVC_SRC_KEY } = require('../../constants')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'
let init = false

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  constructor (span) {
    if (span instanceof PublicSpan) {
      return span
    }

    // Defers loading DatadogSpan until the first span is created, avoiding
    // eager loading of its dependency tree in code paths that never create spans.
    lazyInit()

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

function lazyInit () {
  if (init) return
  init = true
  const DatadogSpan = require('../span')

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
}

// This is only used for startSpan which is guarenteed to not been activated.
function uncachedWrapper (span) {
  lazyInit()
  // This skips the add cache init
  const wrapper = Object.create(PublicSpan.prototype)
  wrapper._span = span
  return wrapper
}

function cacheWrapper (wrapper) {
  if (!cache.has(wrapper._span)) {
    cache.set(wrapper._span, wrapper)
  }
}

module.exports = { PublicSpan, uncachedWrapper, cacheWrapper }
