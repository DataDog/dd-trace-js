/* eslint-disable */

// These polyfills are here because cypress@6.7.0, which we still support for v5, runs its plugin code
// with node12 (no way to circumvent this).

if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    value: (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop),
    writable: true,
    configurable: true,
  })
}

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, 'at', {
    value: function(n) {
      const len = this.length;
      if (len === 0) return undefined;
      let index = Math.trunc(n);
      if (index < 0) index += len;
      return (index < 0 || index >= len) ? undefined : this[index];
    },
    writable: true,
    configurable: true
  })
}