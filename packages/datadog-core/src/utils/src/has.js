'use strict'

module.exports = function has (object, path) {
  const pathArr = path.split('.')
  let property = object
  for (const n of pathArr) {
    if (property.hasOwnProperty(n)) {
      property = property[n]
    } else {
      return false
    }
  }
  return true
}
