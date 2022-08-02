'use strict'
const { inspect } = require('util');

function serialize (obj) {
  // fast check that would otherwise fall under the object case
  if (obj === null) return `null`
  switch (typeof obj) {
    case 'string':
      return `"${obj}"`
    case 'boolean':
      return obj ? 'true' : 'false'
    case 'number':
      if (Number.isInteger(obj)) return `${obj}`
      throw new TypeError(`Can't canonicalize floating point number '${obj}'`)
    case 'object':
      // This will consider all kind of objects as objects, please don't use regex and such
      const list = []
      for (const key of Object.keys(obj).sort()) {
        const val = serialize(obj[key])
        list.push(`${key}:${val}`)
      }
      return '{' + list.join(',') + '}'
  }
  throw new TypeError(`Can't canonicalize ${inspect(obj)} of type ${typeof obj}`);
}

module.exports = {
  serialize
}
