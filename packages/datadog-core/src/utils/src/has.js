'use strict'

module.exports = (object, path) => {
  const pathArr = path.split('.')
  let property = object
  let i
  for (i = 0; i < pathArr.length - 1; i++) {
    const n = pathArr[i]
    if (property.hasOwnProperty(n)) {
      property = property[n]
    } else {
      return false
    }
  }
  if (property.hasOwnProperty(pathArr[i])) return true
  return false
}
