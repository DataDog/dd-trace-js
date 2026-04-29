'use strict'

const { SVC_SRC_KEY } = require('../../constants')
const { createPrivateMap } = require('../../util')

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

  context () {
    return this._span.context.apply(this._span, arguments)
  }

  tracer () {
    return this._span.tracer.apply(this._span, arguments)
  }

  setOperationName () {
    this._span.setOperationName.apply(this._span, arguments)
    return this
  }

  setBaggageItem () {
    this._span.setBaggageItem.apply(this._span, arguments)
    return this
  }

  getBaggageItem () {
    return this._span.getBaggageItem.apply(this._span, arguments)
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

  addLink () {
    return this._span.addLink.apply(this._span, arguments)
  }

  addLinks () {
    return this._span.addLinks.apply(this._span, arguments)
  }

  log () {
    this._span.log.apply(this._span, arguments)
    return this
  }

  logEvent () {
    return this._span.logEvent.apply(this._span, arguments)
  }

  finish () {
    return this._span.finish.apply(this._span, arguments)
  }
}

module.exports = { PublicSpan }
