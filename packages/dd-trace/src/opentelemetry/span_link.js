const log = require('../log')

class SpanLink {
  constructor (traceId, spanId, attributes, traceFlags, traceState) {
    this.traceId = traceId
    this.spanId = spanId
    this.attributes = this._sanitize(attributes)
    this.traceFlags = traceFlags
    this.traceState = traceState
  }

  _sanitize (attributes = {}) {
    const allowed = ['string', 'number', 'boolean']
    const sanitizedAttributes = {}

    function addArrayorScalarAttributes (index, maybeArray) {
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
}

module.exports = SpanLink
