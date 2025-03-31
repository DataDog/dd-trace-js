'use strict'

const { types } = require('util')

function getSizeOrZero (obj) {
  if (typeof obj === 'string') {
    return Buffer.from(obj, 'utf8').length
  }
  if (types.isArrayBuffer(obj)) {
    return obj.byteLength
  }
  if (Buffer.isBuffer(obj)) {
    return obj.length
  }
  if (Array.isArray(obj) && obj.length > 0) {
    if (typeof obj[0] === 'number') return Buffer.from(obj).length
    let payloadSize = 0
    obj.forEach(item => {
      payloadSize += getSizeOrZero(item)
    })
    return payloadSize
  }
  if (obj !== null && typeof obj === 'object') {
    try {
      return getHeadersSize(obj)
    } catch {
      // pass
    }
  }
  return 0
}

function getHeadersSize (headers) {
  if (headers === undefined) return 0
  return Object.entries(headers).reduce((prev, [key, val]) => getSizeOrZero(key) + getSizeOrZero(val) + prev, 0)
}

function getMessageSize (message) {
  const { key, value, headers } = message
  return getSizeOrZero(key) + getSizeOrZero(value) + getHeadersSize(headers)
}

function getAmqpMessageSize (message) {
  const { headers, content } = message
  return getSizeOrZero(content) + getHeadersSize(headers)
}

module.exports = {
  getMessageSize,
  getHeadersSize,
  getSizeOrZero,
  getAmqpMessageSize
}
