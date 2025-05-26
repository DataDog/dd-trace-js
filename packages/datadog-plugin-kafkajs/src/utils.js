'use strict'

function convertToTextMap (bufferMap) {
  if (!bufferMap) return null

  // rdKafka returns an array of header maps
  if (Array.isArray(bufferMap)) {
    const headers = {}
    for (const headerMap of bufferMap) {
      for (const key of Object.keys(headerMap)) {
        headers[key] = headerMap[key].toString()
      }
    }
    return headers
  }

  const textMap = {}
  for (const key of Object.keys(bufferMap)) {
    if (bufferMap[key] === null || bufferMap[key] === undefined) continue
    textMap[key] = bufferMap[key].toString()
  }
  return textMap
}

module.exports = {
  convertToTextMap
}
