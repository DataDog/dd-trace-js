'use strict'

module.exports = (object, path) => {
  const pathArr = path.split('.')
  let val = object
  for (const p of pathArr) {
    if (val === undefined) return val
    val = val[p]
  }
  return val
}
