'use strict'

module.exports = (object, props) => {
  const result = {}
  props.forEach(prop => {
    if (prop in object) {
      result[prop] = object[prop]
    }
  })
  return result
}
