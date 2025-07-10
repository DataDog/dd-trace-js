'use strict'

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
    configurable: true
  })
}
