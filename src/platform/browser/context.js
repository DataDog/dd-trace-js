'use strict'

const context = new Map()

module.exports = config => {
  return {
    get(...args) {
      return context.get(...args);
    },
    set(...args) {
      return context.set(...args);
    },
    bind(fn) {
      return fn
    },
    bindEmitter() {},
  };
}
