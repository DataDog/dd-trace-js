'use strict'

module.exports = function set (object, path, value) {
  let index = path.indexOf('.')
  if (index === -1) {
    object[path] = value
    return
  }

  let property = object[path.slice(0, index)] ??= {}

  while (true) {
    const nextIndex = path.indexOf('.', index + 1)
    if (nextIndex === -1) {
      property[path.slice(index + 1)] = value
      return
    }
    property = property[path.slice(index + 1, nextIndex)] ??= {}
    index = nextIndex
  }
}
