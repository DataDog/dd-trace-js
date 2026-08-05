'use strict'

const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

/** @typedef {string | Buffer | null | undefined} KafkaHeaderValue */
/** @typedef {Record<string, KafkaHeaderValue | KafkaHeaderValue[]>} KafkaHeaderMap */
/** @typedef {Array<Record<string, KafkaHeaderValue>>} NativeHeaderList */

/** @typedef {Record<string, string | string[]>} TextMap */

/**
 * @param {TextMap} textMap
 * @param {string} key
 * @param {KafkaHeaderValue} value
 */
function addHeaderValue (textMap, key, value) {
  if (value === null || value === undefined) return

  const existing = textMap[key]
  if (existing === undefined) {
    textMap[key] = value.toString()
  } else if (typeof existing === 'string') {
    textMap[key] = [existing, value.toString()]
  } else {
    existing.push(value.toString())
  }
}

/** @param {KafkaHeaderMap | NativeHeaderList | null | undefined} bufferMap */
function convertToTextMap (bufferMap) {
  if (!bufferMap) return null

  // A `toString` or `__proto__` wire key would read an inherited value back as a repeat.
  /** @type {TextMap} */
  const textMap = Object.create(null)

  // rdKafka reports one single-key record per wire field.
  if (Array.isArray(bufferMap)) {
    for (const headerMap of bufferMap) {
      for (const key of Object.keys(headerMap)) {
        addHeaderValue(textMap, key, headerMap[key])
      }
    }
    return textMap
  }

  for (const key of Object.keys(bufferMap)) {
    const value = bufferMap[key]
    if (Array.isArray(value)) {
      for (const repeated of value) {
        addHeaderValue(textMap, key, repeated)
      }
    } else {
      addHeaderValue(textMap, key, value)
    }
  }
  return textMap
}

/**
 * A KafkaJS header value array becomes one wire record per element, so its key
 * counts once per value. A native header array already holds one record per
 * entry, where the array indices are not wire bytes.
 *
 * @param {{ key?: unknown, value?: unknown,
 *   headers?: KafkaHeaderMap | NativeHeaderList | null }} message
 */
function getKafkaMessageSize (message) {
  const { key, value, headers } = message
  let size = getSizeOrZero(key) + getSizeOrZero(value)
  if (headers === undefined || headers === null) return size
  if (Array.isArray(headers)) return size + getSizeOrZero(headers)

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
