'use strict'

const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

/** @typedef {string | Buffer | null | undefined} KafkaHeaderValue */
/** @typedef {Record<string, KafkaHeaderValue | KafkaHeaderValue[]>} KafkaHeaderMap */
/** @typedef {Array<Record<string, KafkaHeaderValue>>} NativeHeaderList */

/**
 * @param {KafkaHeaderMap | NativeHeaderList | null | undefined} bufferMap
 */
function convertToTextMap (bufferMap) {
  if (!bufferMap) return null

  // rdKafka returns an array of header maps
  if (Array.isArray(bufferMap)) {
    const headers = {}
    for (const headerMap of bufferMap) {
      for (const key of Object.keys(headerMap)) {
        const value = headerMap[key]
        if (value === null || value === undefined) {
          delete headers[key]
          continue
        }
        headers[key] = value.toString()
      }
    }
    return headers
  }

  const textMap = {}
  for (const key of Object.keys(bufferMap)) {
    const values = bufferMap[key]
    const value = Array.isArray(values) ? values.at(-1) : values
    if (value === null || value === undefined) continue
    textMap[key] = value.toString()
  }
  return textMap
}

/**
 * A KafkaJS header value array becomes one wire record per element. A native
 * header array already contains one record per entry.
 *
 * @param {{ key?: unknown, value?: unknown,
 *   headers?: KafkaHeaderMap | NativeHeaderList | null }} message
 */
function getKafkaMessageSize (message) {
  const { key, value, headers } = message
  let size = getSizeOrZero(key) + getSizeOrZero(value)
  if (headers === undefined || headers === null) return size

  if (Array.isArray(headers)) {
    for (const header of headers) {
      const headerKey = Object.keys(header)[0]
      size += Buffer.byteLength(headerKey, 'utf8') + getSizeOrZero(header[headerKey])
    }
    return size
  }

  for (const headerKey of Object.keys(headers)) {
    const headerValue = headers[headerKey]
    const keySize = Buffer.byteLength(headerKey, 'utf8')
    size += (Array.isArray(headerValue) ? keySize * headerValue.length : keySize) + getSizeOrZero(headerValue)
  }
  return size
}

module.exports = {
  convertToTextMap,
  getKafkaMessageSize,
}
