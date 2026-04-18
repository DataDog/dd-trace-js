'use strict'

// A WeakMap cache at module scope ensures the same wrapper instance is returned
// for the same underlying span across all subclasses, so reference equality
// checks (===) in user code remain stable.
const cache = new WeakMap()

const { SVC_SRC_KEY } = require('../../constants')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'

/** @type {boolean} */
let delegatesInstalled = false

/**
 * DatadogSpan and delegate methods are installed on first wrap. Requiring this
 * module stays cheap (e.g. scope hot paths that load the file but never wrap a
 * span avoid loading ../span.js and building dozens of prototype forwarders).
 */
function installDelegatesIfNeeded () {
  if (delegatesInstalled) return
  delegatesInstalled = true

  const DatadogSpan = require('../span')

  // Whenever a method needs to be modified to have a unique public behavior, it
  // should be implemented on `PublicSpan` directly so it is skipped here.
  for (const method of Object.getOwnPropertyNames(DatadogSpan.prototype)) {
    if (method === 'constructor' || method.startsWith('_') || PublicSpan.prototype[method]) {
      continue
    }
    PublicSpan.prototype[method] = function () {
      const result = this._span[method].apply(this._span, arguments)
      // always return wrapper span when the result is the span itself
      return result === this._span ? this : result
    }
  }
}

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  constructor (span) {
    if (span instanceof PublicSpan) {
      return span
    }
    installDelegatesIfNeeded()

    const cached = cache.get(span)
    if (cached !== undefined) {
      return cached
    }
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

// Skip the identity cache. `Scope#activate` promotes the wrapper when given
// one, so `scope.active()` still returns this instance within the activation.
function fresh (span) {
  installDelegatesIfNeeded()
  const wrapper = Object.create(PublicSpan.prototype)
  wrapper._span = span
  return wrapper
}

function cacheWrapper (wrapper) {
  if (!cache.has(wrapper._span)) {
    cache.set(wrapper._span, wrapper)
  }
}

module.exports = { PublicSpan, fresh, cacheWrapper }
