'use strict'

module.exports = str => {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string')
  }

  return str
    .trim()
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll('_', '-')
    .replaceAll(/-{2,}/g, '-')
    .toLowerCase()
}
