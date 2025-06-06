'use strict'

module.exports = function has (object, path) {
  const pathArr = path.split('.')
  let property = object
  for (const n of pathArr) {
    if (Object.hasOwn(property, n)) {
      property = property[n]
    } else {
      return false
    }
  }
  return true
}
