'use strict'

module.exports = function set (object, path, value) {
  let index = -1
  while (true) {
    const nextIndex = path.indexOf('.', index + 1)
    if (nextIndex === -1) {
      object[path.slice(index + 1)] = value
      return
    }
    object = object[path.slice(index + 1, nextIndex)] ??= {}
    index = nextIndex
  }
}
