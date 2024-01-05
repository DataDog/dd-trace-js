const log = require('../log')

const TextMapPropagator = require('./propagation/text_map')
const traceContextInjector = new TextMapPropagator({ tracePropagationStyle: { inject: 'tracecontext' } })

const id = require('../id')

// assumed the string ID passed is hexadecimal
function enforceId (maybeId) {
  return typeof maybeId === 'string' ? id(maybeId) : maybeId
}

class SpanLink {
  constructor ({ traceId, spanId, attributes, flags, tracestate, traceIdHigh }) {
    // mandatory, enforcing IDs in the case they were not formatted in `from`
    this.traceId = enforceId(traceId)
    this.spanId = enforceId(spanId)

    // optional
    this.flags = flags
    this.tracestate = tracestate
    this.traceIdHigh = traceIdHigh

    // for efficiency, build up encoded version so we don't have to stringify large object later
    // partially encoded information is immutable after this point
    this._partialEncoded = this._partialToString() // only call stringify once at first partial encoding
    this._attributesString = '{' // include this character in length computations

    this._droppedAttributesCount = 0
    this.attributes = this._sanitize(attributes)
  }

  /**
   * Will create a span link from the provided information. If only a link object is provided,
   * it must include the (spanId, traceId) tuple, and any other relevant information manually set.
   * If a spanContext is also provided, and the traceId matches, it will be used to fill in
   * any other information (flags, tracestate, high 64 bits of traceId). If the traceId does not match,
   * it is assumed the traceId given in the link object is correct, and the spanContext is ignored.
   *
   * Additionally, only a spanId can be provided in the link object. In this case, it is assumed
   * to be a part of the same trace as provided in the spanContext. If no spanID is provided in the link object,
   * the spanContext's parent spanId is used.
   *
   * @param {*} link Lightweight representation of a span
   * @param {*} spanContext Fallback information for the link
   * @returns Span link based on the given information
   */
  static from (link = {}, spanContext) {
    const traceId = enforceId(link.traceId || spanContext._traceId)
    const spanId = enforceId(link.spanId || spanContext._parentId)
    const attributes = link.attributes || {}

    const sameTrace = spanContext && traceId.equals(spanContext._traceId)
    if (!sameTrace) return new SpanLink({ ...link, traceId, spanId, attributes })

    // _tracestate only set when w3c trace flags are given
    let maybeTraceFlags
    if (spanContext?._tracestate) {
      maybeTraceFlags = spanContext._sampling.priority > 0 ? 1 : 0
    }
    const flags = link.flags ?? maybeTraceFlags

    const traceIdHigh = link.traceIdHigh || spanContext?._trace.tags['_dd.p.tid']

    let tracestate = link.tracestate || spanContext?._tracestate
    if (!tracestate && spanContext?._trace?.origin) {
      // inject extracted Datadog HTTP headers into local tracestate
      // indicated by _trace.origin
      const extractedTracestate = {}
      traceContextInjector.inject(spanContext, extractedTracestate)
      tracestate = extractedTracestate.tracestate
    }

    return new SpanLink({ traceId, spanId, attributes, flags, tracestate, traceIdHigh })
  }

  // TODO is there really a performance benefit from stringifying everything as it's built?
  // or can it just be stringified objects here...
  get length () {
    return (
      Buffer.byteLength(this._partialEncoded) +
      Buffer.byteLength(this._attributesToString()) +
      Buffer.byteLength(this._droppedAttributesCountToString())
    )
  }

  _sanitize (attributes = {}) {
    const allowed = ['string', 'number', 'boolean']
    const sanitizedAttributes = {}

    const addArrayorScalarAttributes = (key, maybeArray) => {
      if (Array.isArray(maybeArray)) {
        for (const subkey in maybeArray) {
          addArrayorScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
        }
      } else {
        const maybeScalar = maybeArray
        if (allowed.includes(typeof maybeScalar)) {
          sanitizedAttributes[key] = maybeScalar
          if (this._attributesString.length === 1) { // no attributes yet
            this._attributesString += `"${key}":"${maybeScalar}"}`
          } else {
            this._attributesString = this._attributesString.slice(0, -1) + `,"${key}":"${maybeScalar}"}`
          }
        } else {
          log.warn(`Dropping span link attribute.`)
          this._droppedAttributesCount++
        }
      }
    }

    Object
      .entries(attributes)
      .forEach(entry => {
        const [key, value] = entry
        addArrayorScalarAttributes(key, value)
      })

    return sanitizedAttributes
  }

  addAttribute (key, value) {
    const attribute = this._sanitize({ [key]: value })
    Object.assign(this.attributes, attribute)
  }

  flushAttributes () {
    this._droppedAttributesCount += this._attributesLength

    this.attributes = {}
    this._attributesString = '{'
  }

  toString () {
    let encoded = this._partialEncoded.slice(0, -1) + ','

    if (this._attributesLength) {
      encoded += this._attributesToString()
    }

    if (this._droppedAttributesCount) {
      encoded += this._droppedAttributesCountToString()
    }
    return encoded.slice(0, -1) + '}' // replace trailing comma
  }

  _partialToString () {
    const link = {}

    // these values are always added
    if (this.traceIdHigh) {
      link.trace_id = this.traceIdHigh + this.traceId.toString()
      link.trace_id_high = this.traceIdHigh
    } else {
      link.trace_id = this.traceId.toString()
    }
    link.span_id = this.spanId.toString()

    // these values are conditionally added
    if (this.tracestate) link.tracestate = this.tracestate.toString()
    if (!isNaN(Number(this.flags))) link.flags = this.flags // 0 is a valid flag, but undefined is not

    return JSON.stringify(link)
  }

  get _attributesLength () {
    return Object.keys(this.attributes).length
  }

  _attributesToString () {
    if (!this._attributesLength) return '' // don't include if 0
    return `"attributes":${this._attributesString},`
  }

  _droppedAttributesCountToString () {
    if (!this._droppedAttributesCount) return '' // don't include if 0
    return `"dropped_attributes_count":"${this._droppedAttributesCount}",`
  }
}

module.exports = SpanLink
