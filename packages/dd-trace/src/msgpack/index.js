'use strict'

const MsgpackChunk = require('./chunk')

/**
 * Encode an arbitrary JS value as a standalone msgpack buffer.
 *
 * @param {unknown} value
 * @param {number} [initialSize] Initial buffer size in bytes.
 * @returns {Buffer}
 */
function encode (value, initialSize) {
  const bytes = new MsgpackChunk(initialSize)
  writeValue(bytes, value)

  return bytes.buffer.subarray(0, bytes.length)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  return typeof value === 'object' && value !== null
}

/**
 * @param {MsgpackChunk} bytes
 * @param {unknown} value
 */
function writeValue (bytes, value) {
  switch (typeof value) {
    case 'string':
      bytes.write(value)
      break
    case 'number':
      bytes.writeNumber(value)
      break
    case 'object':
      if (value === null) {
        bytes.writeNull()
      } else if (Array.isArray(value)) {
        writeArray(bytes, value)
      } else if (Buffer.isBuffer(value)) {
        bytes.writeBin(value)
      } else if (ArrayBuffer.isView(value)) {
        bytes.writeBin(/** @type {Uint8Array} */ (value))
      } else if (isPlainObject(value)) {
        writeMap(bytes, value)
      }
      break
    case 'boolean':
      bytes.writeBoolean(value)
      break
    case 'bigint':
      bytes.writeBigInt(value)
      break
    case 'symbol':
      bytes.write(value.toString())
      break
    default: // function, undefined
      bytes.writeNull()
      break
  }
}

/**
 * @param {MsgpackChunk} bytes
 * @param {unknown[]} value
 */
function writeArray (bytes, value) {
  if (value.length < 16) {
    bytes.writeFixArray(value.length)
  } else {
    bytes.writeArrayPrefix(value)
  }

  for (const item of value) {
    writeValue(bytes, item)
  }
}

/**
 * @param {MsgpackChunk} bytes
 * @param {Record<string, unknown>} value
 */
function writeMap (bytes, value) {
  const keys = Object.keys(value)

  bytes.writeMapPrefix(keys.length)

  for (const key of keys) {
    bytes.write(key)
    writeValue(bytes, value[key])
  }
}

module.exports = {
  MsgpackChunk,
  encode,
  MAX_SIZE: MsgpackChunk.MAX_SIZE,
  OverflowError: MsgpackChunk.OverflowError,
}
