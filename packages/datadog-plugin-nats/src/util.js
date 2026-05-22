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
    case 'request':
    case 'requestMany':
      return 'request'
    default:
      return 'publish'
  }
}

module.exports = {
  headersToTextMap,
  getOperationName,
}
