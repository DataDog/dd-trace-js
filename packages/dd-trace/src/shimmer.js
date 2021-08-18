'use strict'

// This module is just shimmer, with the difference that if the object
// doesn't have the `propertyIsEnumerable` function, we'll just go ahead and
// assign the value, rather than attempting to use `Object.defineProperty`.
// This is to handle the case where properties are assigned via
// `import-in-the-middle`.
//
// `wrap` and `masswrap` here are straight copies of their counterparts in
// shimmer, with logging and arg checking removed (since we know exactly what
// we're giving to it, and that it's correct), and unused code paths removed.
// `defineProperty` is altered as described above.

const shimmer = require('shimmer')

function defineProperty (obj, name, value) {
  if (!obj.propertyIsEnumerable) {
    obj[name] = value
    return
  }
  const enumerable = !!obj[name] && obj.propertyIsEnumerable(name)
  Object.defineProperty(obj, name, {
    configurable: true,
    enumerable: enumerable,
    writable: true,
    value: value
  })
}

function wrap (nodule, name, wrapper) {
  const original = nodule[name]
  const wrapped = wrapper(original, name)

  defineProperty(wrapped, '__original', original)
  defineProperty(wrapped, '__unwrap', function () {
    if (nodule[name] === wrapped) defineProperty(nodule, name, original)
  })
  defineProperty(wrapped, '__wrapped', true)

  defineProperty(nodule, name, wrapped)
  return wrapped
}

function massWrap (nodules, names, wrapper) {
  nodules.forEach(function (nodule) {
    names.forEach(function (name) {
      wrap(nodule, name, wrapper)
    })
  })
}

const newShimmer = (...args) => shimmer(...args)

module.exports = Object.assign(newShimmer, shimmer, { wrap, massWrap })
