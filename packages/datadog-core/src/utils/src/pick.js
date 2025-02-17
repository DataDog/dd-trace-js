'use strict'

module.exports = (object, props) => {
  const result = {}
  for (const prop of props) {
    if (prop in object) {
      result[prop] = object[prop]
    }
  }
  return result
}
