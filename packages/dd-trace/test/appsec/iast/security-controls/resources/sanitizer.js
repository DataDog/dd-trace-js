'use strict'

function sanitize (input) {
  return `sanitized ${input}`
}

function sanitizeObject (input) {
  return { sanitized: true, ...input }
}

module.exports = {
  sanitize,
  sanitizeObject,

  nested: {
    sanitize
  }
}
