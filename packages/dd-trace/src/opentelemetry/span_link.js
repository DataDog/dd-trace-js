const log = require('../log')

class SpanLink {
  // spanContext, attributes
  constructor ({ traceId, spanId, attributes, traceFlags, traceState }) {
    this.traceId = traceId
    this.spanId = spanId
    this.attributes = this._sanitize(attributes)
    this.flags = traceFlags
    this.traceState = traceState

    this._droppedAttributesCount = 0

    // for efficiency, build up encoded version so we don't have to stringify large object later
    this._encoded = this.toString() // only call stringify once at first encoding
    this._attributesString = '{' // include this character in length computations
  }

  // static from (spanContext) {
  //   const { _traceID, _spanID, _tracestate } = spanContext
  //   // return new SpanLink(link)
  // }

  // off by 1 or off by 2 depending
  get length () {
    return (
      Buffer.byteLength(this.toString()) + // everything except attributes and droppedattributescount
      Buffer.byteLength(this._attributesEncoded()) +
      Buffer.byteLength(this._droppedAttributesCountEncoded()))
  }

  _sanitize (attributes = {}) {
    const allowed = ['string', 'number', 'boolean']
    const sanitizedAttributes = {}

    const addArrayorScalarAttributes = (index, maybeArray) => {
      if (Array.isArray(maybeArray)) {
        for (const subkey in maybeArray) {
          addArrayorScalarAttributes(`${index}.${subkey}`, maybeArray[subkey])
        }
      } else {
        const maybeScalar = maybeArray
        if (allowed.includes(typeof maybeScalar)) {
          sanitizedAttributes[index] = maybeScalar
          if (this._attributesString.length === 1) { // no attributes yet
            this._attributesString += `"${index}":"${maybeScalar}"}`
          } else {
            this._attributesString = this._attributesString.slice(0, -1) + `,"${index}":"${maybeScalar}"}`
          }
        } else {
          log.warn(
            `Cannot sanitize type ${typeof maybeScalar} with key ${index}.
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
    this._attributesEncoded = ''
  }

  encode () {
    let encoded = this._encoded.slice(0, -1) + ','

    if (this.attributesLength > 1) {
      encoded += this._attributesEncoded()
    }

    if (this._droppedAttributesCount) {
      encoded += this._droppedAttributesCountEncoded()
    }
    return encoded.slice(0, -1) + '}' // replace trailing comma
  }

  // TODO rename?
  toString () {
    const link = {}

    // these values are always added
    link.trace_id = this.traceId
    link.span_id = this.spanId

    // these values are conditionally added
    if (this.traceState) link.tracestate = this.traceState
    if (this.flags) link.flags = this.flags

    return JSON.stringify(link)
  }

  get attributesLength () {
    return Object.keys(this.attributes).length
  }

  _attributesEncoded () {
    if (this.attributesLength > 1) return `"attributes":${this._attributesString},` // don't include if 0
    return ''
  }

  _droppedAttributesCountEncoded () {
    if (!this._droppedAttributesCount) return '' // don't include if 0
    return `"dropped_attributes_count":"${this._droppedAttributesCount}",`
  }
}

module.exports = SpanLink
