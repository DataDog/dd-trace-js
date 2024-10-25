'use strict'

module.exports = str => {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string')
  }

  return str
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/_/g, '-')
    .replace(/-{2,}/g, '-')
    .toLowerCase()
}
