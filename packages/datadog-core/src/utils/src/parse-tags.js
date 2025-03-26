'use strict'

const digitRegex = /^\d+$/

/**
 * Converts a flat object of tags into a nested object. For example:
 *   { 'a.b.c': 'value' } -> { a: { b: { c: 'value' } } }
 * Also supports array-keys. For example:
 *   { 'a.0.b': 'value' } -> { a: [{ b: 'value' }] }
 *
 * @param {Object} tags - Key/value pairs of tags
 * @returns Object - Parsed tags
 */
module.exports = tags => {
  const parsedTags = {}
  for (const [tag, value] of Object.entries(tags)) {
    const keys = tag.split('.')
    let current = parsedTags
    let depth = 0
    for (const key of keys) {
      if (!current[key]) {
        if (depth === keys.length - 1) {
          current[key] = value
          break
        }
        current[key] = keys[depth + 1]?.match(digitRegex) ? [] : {}
      }
      current = current[key]
      depth++
    }
  }
  return parsedTags
}
