'use strict'

module.exports = function kebabcase (str) {
  if (typeof str !== 'string') {
    throw new TypeError('Expected a string')
  }

  const kebab = str
    .trim()
    .replaceAll(/([a-z])([A-Z])/g, '$1-$2') // Convert camelCase to kebab-case
    .replaceAll(/[\s_]+/g, '-') // Replace spaces and underscores with a single dash
    .toLowerCase()

  // Trim by index; a `/-+$/` regex re-examines the dash run once per start position.
  let start = 0
  let end = kebab.length
  while (kebab.charCodeAt(start) === 45) start++ // '-'
  while (end > start && kebab.charCodeAt(end - 1) === 45) end--
  return kebab.slice(start, end)
}
