'use strict'

module.exports = function kebabcase (str) {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string')
  }

  return str
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2') // Convert camelCase to kebab-case
    .replace(/[\s_]+/g, '-') // Replace spaces and underscores with a single dash
    .replace(/^-+|-+$/g, '') // Trim leading and trailing dashes
    .toLowerCase()
}
