'use strict'

module.exports = (object, path, value) => {
  const pathArr = path.split('.')
  let property = object
  let i
  for (i = 0; i < pathArr.length - 1; i++) {
    const n = pathArr[i]
    if (property.hasOwnProperty(n)) {
      property = property[n]
    } else {
      property[n] = property = {}
    }
  }
  property[pathArr[i]] = value
}
