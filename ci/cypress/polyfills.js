'use strict'

// node: prefix for built-in modules (e.g. require('node:path')) was added in
// Node.js 14.18.0 / 16.0.0. Cypress 6.7.0 runs on Node.js 12, so we patch
// Module._resolveFilename to strip the prefix before any dd-trace code loads.
const Module = require('module')
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  return originalResolveFilename.call(
    this,
    request.startsWith('node:') ? request.slice(5) : request,
    parent,
    isMain,
    options
  )
}

if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    // eslint-disable-next-line prefer-object-has-own
    value: (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop),
    writable: true,
    configurable: true,
  })
}

if (!Array.prototype.at) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'at', {
    value: function (n) {
      const len = this.length
      if (len === 0) return
      let index = Math.trunc(n)
      if (index < 0) index += len
      return (index < 0 || index >= len) ? undefined : this[index]
    },
    writable: true,
    configurable: true,
  })
}
