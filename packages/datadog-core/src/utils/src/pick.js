'use strict'

module.exports = function pick (object, props) {
  const result = {}
  props.forEach(prop => {
    if (Object.hasOwn(object, prop)) {
      result[prop] = object[prop]
    }
  })
  return result
}
