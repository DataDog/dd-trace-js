'use strict'

module.exports = (object, path) => {
  const pathArr = path.split('.')
  let val = object
  for (const p in pathArr) {
    if (val === undefined) return val
    val = val[pathArr[p]]
  }
  return val
}
