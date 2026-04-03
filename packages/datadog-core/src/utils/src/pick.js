'use strict'

module.exports = function pick (object, props) {
  const result = {}
  for (const prop of props) {
    if (Object.hasOwn(object, prop)) {
      result[prop] = object[prop]
    }
  }
  return result
}
