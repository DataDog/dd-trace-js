'use strict'
const { inspect } = require('util')

function serialize (obj) {
  // fast check that would otherwise fall under the object case
  if (obj === null) return `null`
  const objAsList = []
  switch (typeof obj) {
    case 'string':
      // This should give us properly escaped strings
      return JSON.stringify(obj)
    case 'boolean':
      return obj ? 'true' : 'false'
    case 'number':
      if (Number.isInteger(obj)) return `${obj}`
      throw new TypeError(`Can't canonicalize floating point number '${obj}'`)
    case 'object': // FIXME: stringObject
      if (obj instanceof RegExp) throw new TypeError(`Can't canonicalize ${inspect(obj)} of type RegExp`)
      if (obj instanceof String) return JSON.stringify(obj)
      for (const key of Object.keys(obj).sort()) {
        const val = serialize(obj[key])
        objAsList.push(`"${key}":${val}`)
      }
      return '{' + objAsList.join(',') + '}'
  }
  throw new TypeError(`Can't canonicalize ${inspect(obj)} of type ${typeof obj}`)
}

module.exports = {
  serialize
}
