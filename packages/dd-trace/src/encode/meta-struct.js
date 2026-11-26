'use strict'

const MsgpackChunk = require('../msgpack/chunk')

/**
 * @typedef {(bytes: MsgpackChunk, value: string) => void} StringEncoder
 */

/**
 * @param {MsgpackChunk} bytes
 * @param {string} value
 */
function writeStringDirect (bytes, value) {
  bytes.write(value)
}

/**
 * @param {unknown} value
 */
function isEncodableMetaStructValue (value) {
  const type = typeof value
  return type === 'string' || type === 'number' || type === 'boolean' ||
    (value !== null && type === 'object')
}

/**
 * @param {unknown} value
 * @param {Set<unknown>} seen
 */
function isEncodableNestedValue (value, seen) {
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  return value !== null && type === 'object' && !seen.has(value)
}

/**
 * @param {MsgpackChunk} bytes
 * @param {string | number | boolean} value
 * @param {StringEncoder} encodeString
 */
function encodePrimitive (bytes, value, encodeString) {
  switch (typeof value) {
    case 'string':
      encodeString(bytes, value)
      break
    case 'number':
      bytes.writeFloat(value)
      break
    case 'boolean':
      bytes.writeBoolean(value)
      break
  }
}

/**
 * @param {MsgpackChunk} bytes
 * @param {Record<string, unknown>} value
 * @param {Set<unknown>} seen
 * @param {StringEncoder} encodeString
 */
function encodeObjectAsMap (bytes, value, seen, encodeString) {
  const offset = bytes.length
  bytes.reserve(5)
  bytes.buffer[offset] = 0xDF

  let count = 0
  for (const key of Object.keys(value)) {
    const entryValue = value[key]
    if (isEncodableNestedValue(entryValue, seen)) {
      encodeString(bytes, key)
      encodeMetaStructObject(bytes, entryValue, encodeString, seen)
      count++
    }
  }

  const target = bytes.buffer
  target[offset + 1] = count >>> 24
  target[offset + 2] = count >>> 16
  target[offset + 3] = count >>> 8
  target[offset + 4] = count
}

/**
 * @param {MsgpackChunk} bytes
 * @param {unknown[]} value
 * @param {Set<unknown>} seen
 * @param {StringEncoder} encodeString
 */
function encodeObjectAsArray (bytes, value, seen, encodeString) {
  const offset = bytes.length
  bytes.reserve(5)
  bytes.buffer[offset] = 0xDD

  let count = 0
  for (const item of value) {
    if (isEncodableNestedValue(item, seen)) {
      encodeMetaStructObject(bytes, item, encodeString, seen)
      count++
    }
  }

  const target = bytes.buffer
  target[offset + 1] = count >>> 24
  target[offset + 2] = count >>> 16
  target[offset + 3] = count >>> 8
  target[offset + 4] = count
}

/**
 * Encode one `meta_struct` entry value into `bytes` using the v0.4 trace
 * representation (numbers as float64, `null`/`undefined`/unsupported types and
 * circular references omitted).
 *
 * @param {MsgpackChunk} bytes
 * @param {unknown} value
 * @param {StringEncoder} [encodeString]
 * @param {Set<unknown>} [seen]
 */
function encodeMetaStructObject (bytes, value, encodeString = writeStringDirect, seen = new Set()) {
  if (Array.isArray(value)) {
    seen.add(value)
    encodeObjectAsArray(bytes, value, seen, encodeString)
  } else if (value !== null && typeof value === 'object') {
    seen.add(value)
    encodeObjectAsMap(bytes, /** @type {Record<string, unknown>} */ (value), seen, encodeString)
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    encodePrimitive(bytes, value, encodeString)
  }
}

/**
 * Encode a single `meta_struct` entry value as a standalone MessagePack buffer.
 *
 * @param {unknown} value
 * @param {number} [initialSize] Initial buffer size in bytes.
 * @returns {Buffer}
 */
function encodeMetaStructValue (value, initialSize) {
  const bytes = new MsgpackChunk(initialSize)
  encodeMetaStructObject(bytes, value)

  return bytes.buffer.subarray(0, bytes.length)
}

module.exports = {
  encodeMetaStructObject,
  encodeMetaStructValue,
  isEncodableMetaStructValue,
}
