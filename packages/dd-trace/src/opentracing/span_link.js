const log = require('../log')

const TextMapPropagator = require('./propagation/text_map')
const traceContext = new TextMapPropagator({ tracePropagationStyle: { inject: 'tracecontext' } })

class SpanLink {
  constructor (traceId, spanId, attributes, traceFlags, traceState, traceIdHigh) {
    // mandatory
    this.traceId = traceId
    this.spanId = spanId

    // optional
    // TODO trace_id_high
    this.flags = traceFlags
    this.tracestate = traceState
    this.traceIdHigh = traceIdHigh

    // for efficiency, build up encoded version so we don't have to stringify large object later
    this._encoded = this._partialEncode() // only call stringify once at first partial encoding
    this._attributesString = '{' // include this character in length computations
    this.attributes = this._sanitize(attributes)

    this._droppedAttributesCount = 0
  }

  static from (link = {}, spanContext) {
    // prioritize information in links over span context
    const traceId = link.traceId || spanContext._traceId
    const spanId = link.spanId || spanContext._parentId || spanContext._spanId
    const attributes = link.attributes || {}

    // this still isn't right...
    const traceFlags = link.flags || spanContext._sampling.priority > 0 ? 1 : 0

    const traceIdHigh = link.traceIdHigh || spanContext._trace.tags['_dd.p.tid']

    let tracestate = link.tracestate || spanContext._tracestate
    if (!tracestate && spanContext._trace?.origin) {
      // inject extracted Datadog HTTP headers into tracestate
      // indicated by _trace.origin
      const extractedTracestate = {}
      traceContext.inject(spanContext, extractedTracestate)
      tracestate = extractedTracestate.tracestate
    }

    return new SpanLink(traceId, spanId, attributes, traceFlags, tracestate, traceIdHigh)
  }

  get length () {
    return (
      Buffer.byteLength(this._encoded) +
      Buffer.byteLength(this._attributesEncoded()) +
      Buffer.byteLength(this._droppedAttributesCountEncoded()))
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
          log.warn(
            `Cannot sanitize type ${typeof maybeScalar} with key ${key}.
            \rSupported types are string, number, or boolean. Dropping attribute.`
          )
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
    this._droppedAttributesCount += this.attributesLength

    this.attributes = {}
    this._attributesEncoded = '{'
  }

  toString () {
    let encoded = this._encoded.slice(0, -1) + ','

    if (this.attributesLength) {
      encoded += this._attributesEncoded()
    }

    if (this._droppedAttributesCount) {
      encoded += this._droppedAttributesCountEncoded()
    }
    return encoded.slice(0, -1) + '}' // replace trailing comma
  }

  _partialEncode () {
    const link = {}

    // these values are always added
    link.trace_id = this.traceId.toString(10)
    link.span_id = this.spanId.toString(10)

    // these values are conditionally added
    if (this.tracestate) link.tracestate = this.tracestate.toString()
    if (this.flags) link.flags = this.flags
    if (this.traceIdHigh) link.trace_id_high = this.traceIdHigh

    return JSON.stringify(link)
  }

  get attributesLength () {
    return Object.keys(this.attributes).length
  }

  _attributesEncoded () {
    if (!this.attributesLength) '' // don't include if 0
    return `"attributes":${this._attributesString},`
  }

  _droppedAttributesCountEncoded () {
    if (!this._droppedAttributesCount) return '' // don't include if 0
    return `"dropped_attributes_count":"${this._droppedAttributesCount}",`
  }
}

module.exports = SpanLink
