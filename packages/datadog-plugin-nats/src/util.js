'use strict'

function headersToTextMap (msgHdrs) {
  if (!msgHdrs || typeof msgHdrs[Symbol.iterator] !== 'function') return null
  const textMap = {}
  for (const [key, values] of msgHdrs) {
    if (!Array.isArray(values) || values.length === 0) continue
    textMap[key] = values[0]
  }
  return textMap
}

function getOperationName (type) {
  switch (type) {
    case 'publish':
      return 'publish'
    case 'request':
    case 'requestMany':
      return 'request'
    default:
      // Surface unrecognized operations explicitly rather than silently
      // collapsing them into 'publish' — if NATS adds a new outbound API,
      // this lets us see it in traces and fix the mapping deliberately.
      return 'unknown'
  }
}

module.exports = {
  headersToTextMap,
  getOperationName,
}
