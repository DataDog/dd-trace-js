'use strict'

const { SVC_SRC_KEY } = require('../../constants')

const SERVICE_KEY = 'service'
const SERVICE_NAME_KEY = 'service.name'

const sym = Symbol('dd.publicSpan')

/**
 * This is a public wrapper of Span, this allows distinguishing internal usage from
 * external usage and acting accordingly.
 */
class PublicSpan {
  #span

  constructor (span) {
    if (span[sym]) return span[sym]

    this.#span = span
    span[sym] = this
  }

  context () {
    return this.#span.context.apply(this.#span, arguments)
  }

  tracer () {
    return this.#span.tracer.apply(this.#span, arguments)
  }

  setOperationName () {
    this.#span.setOperationName.apply(this.#span, arguments)
    return this
  }

  setBaggageItem () {
    this.#span.setBaggageItem.apply(this.#span, arguments)
    return this
  }

  getBaggageItem () {
    return this.#span.getBaggageItem.apply(this.#span, arguments)
  }

  setTag (key, value) {
    if (key === SERVICE_KEY || key === SERVICE_NAME_KEY) {
      this.#span.setTag(SVC_SRC_KEY, 'm')
    }
    this.#span.setTag(key, value)
    return this
  }

  addTags (tags) {
    if (tags && (tags[SERVICE_KEY] || tags[SERVICE_NAME_KEY])) {
      this.#span.setTag(SVC_SRC_KEY, 'm')
    }
    this.#span.addTags(tags)
    return this
  }

  addLink () {
    return this.#span.addLink.apply(this.#span, arguments)
  }

  addLinks () {
    return this.#span.addLinks.apply(this.#span, arguments)
  }

  log () {
    this.#span.log.apply(this.#span, arguments)
    return this
  }

  logEvent () {
    return this.#span.logEvent.apply(this.#span, arguments)
  }

  finish () {
    return this.#span.finish.apply(this.#span, arguments)
  }

  static _unwrap(value) {
    if (!value) return
    return value.#span ?? value
  }
}

const unwrap = PublicSpan._unwrap
delete PublicSpan._unwrap

module.exports = { PublicSpan, unwrap }
