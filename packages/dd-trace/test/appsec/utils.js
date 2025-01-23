'use strict'

function getWebSpan (traces) {
  for (const trace of traces) {
    for (const span of trace) {
      if (span.type === 'web') {
        return span
      }
    }
  }
  throw new Error('web span not found')
}

module.exports = {
  getWebSpan
}
