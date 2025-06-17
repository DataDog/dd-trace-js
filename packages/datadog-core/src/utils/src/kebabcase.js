'use strict'

module.exports = function kebabcase (str) {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string')
  }

  return str
    .trim()
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2') // Convert camelCase to kebab-case
    .replaceAll(/[\s_]+/g, '-') // Replace spaces and underscores with a single dash
    .replaceAll(/^-+|-+$/g, '') // Trim leading and trailing dashes
    .toLowerCase()
}
