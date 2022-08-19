'use strict'

function generateCaller (method) {
  return function (self, ...args) {
    return method.apply(self, args)
  }
}

const primordials = {
  ArrayPrototypePush: generateCaller(Array.prototype.push),
  ArrayPrototypeSlice: generateCaller(Array.prototype.slice),
  ArrayPrototypeSort: generateCaller(Array.prototype.sort),
  ArrayIsArray: Array.isArray,
  ObjectPrototypeHasOwnProperty: generateCaller(Object.prototype.hasOwnProperty),
  StringPrototypeCharAt: generateCaller(String.prototype.charAt)
}

module.exports = primordials
