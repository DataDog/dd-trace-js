const log = require('../log')

class SpanLink {
  constructor ({ traceId, spanId, attributes, traceFlags, traceState }) {
    this.traceId = traceId
    this.spanId = spanId
    this.attributes = this._sanitize(attributes)
    this.traceFlags = traceFlags
    this.traceState = traceState

    this._droppedAttributesCount = 0
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
        } else {
          log.warn(
            `Cannot sanitize type ${typeof maybeScalar} with key ${index}.
            \rSupported types are string, number, or boolean.`
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

  addAttribute (attribute) {
    attribute = this._sanitize(attribute)
    Object.assign(this.attributes, attribute)
  }

  // not sure if this is the right spot
  toObject () {
    const link = {}

    // these values are conditionally added
    if (this._droppedAttributesCount) link.droppedAttributesCount = this._droppedAttributesCount
    if (this.traceState) link.traceState = this.traceState
    if (this.traceFlags) link.traceFlags = this.traceFlags
    if (Object.keys(this.attributes).length) link.attributes = this.attributes

    // these values are always added
    link.traceId = this.traceId
    link.spanId = this.spanId

    return link
  }
}

module.exports = SpanLink
