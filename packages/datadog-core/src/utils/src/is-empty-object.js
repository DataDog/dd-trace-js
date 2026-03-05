'use strict'

/**
 * Check if an object has no own enumerable properties.
 * This is faster than Object.keys(obj).length === 0 because it avoids
 * allocating an intermediate array.
 * @param {object} obj
 * @returns {boolean}
 */
module.exports = function isEmptyObject (obj) {
  // eslint-disable-next-line no-restricted-syntax
  for (const key in obj) {
    if (Object.hasOwn(obj, key)) return false
  }
  return true
}
