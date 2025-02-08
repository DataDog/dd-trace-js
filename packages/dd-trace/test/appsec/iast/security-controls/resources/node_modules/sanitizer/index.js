'use strict'

function sanitize (input) {
  return `sanitized ${input}`
}

module.exports = {
  sanitize,

  nested: {
    sanitize
  }
}
