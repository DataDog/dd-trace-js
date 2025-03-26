'use strict'

function convertToTextMap (bufferMap) {
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
