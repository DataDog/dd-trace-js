'use strict'

const MAX_COLLECTION_ENTRIES = 100_000
const MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_NESTING_DEPTH = 128
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MAX_STRING_BYTES = 64 * 1024

/**
 * Converts one bounded MessagePack value to JSON without losing 64-bit integer precision.
 *
 * @param {Buffer} input encoded MessagePack payload
 * @returns {Buffer} JSON payload
 */
function msgpackToJson (input) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error('MessagePack validation payload must be a non-empty Buffer.')
  }
  if (input.length > MAX_INPUT_BYTES) {
    throw new Error(`MessagePack validation payload exceeds ${MAX_INPUT_BYTES} bytes.`)
  }

  const writer = new BoundedJsonWriter()
  const converter = new MsgpackJsonConverter(input, writer)
  converter.convert()
  return writer.toBuffer()
}

class BoundedJsonWriter {
  #bytes = 0
  #chunks = []

  /**
   * Appends one JSON fragment while enforcing the aggregate output limit.
   *
   * @param {string} fragment JSON fragment
   */
  write (fragment) {
    const bytes = Buffer.byteLength(fragment)
    if (this.#bytes + bytes > MAX_OUTPUT_BYTES) {
      throw new Error(`JSON validation payload exceeds ${MAX_OUTPUT_BYTES} bytes.`)
    }
    this.#bytes += bytes
    this.#chunks.push(fragment)
  }

  /**
   * Materializes the completed bounded JSON payload.
   *
   * @returns {Buffer} JSON payload
   */
  toBuffer () {
    return Buffer.from(this.#chunks.join(''))
  }
}

class MsgpackJsonConverter {
  #collectionEntries = 0
  #input
  #offset = 0
  #writer

  /**
   * Creates a converter for one MessagePack payload.
   *
   * @param {Buffer} input encoded MessagePack payload
   * @param {BoundedJsonWriter} writer bounded JSON writer
   */
  constructor (input, writer) {
    this.#input = input
    this.#writer = writer
  }

  /**
   * Converts exactly one top-level value and rejects trailing data.
   */
  convert () {
    this.#writeValue(0)
    if (this.#offset !== this.#input.length) {
      throw new Error('MessagePack validation payload contains trailing data.')
    }
  }

  /**
   * Writes one MessagePack value as JSON.
   *
   * @param {number} depth current nesting depth
   */
  #writeValue (depth) {
    if (depth > MAX_NESTING_DEPTH) {
      throw new Error('MessagePack nesting exceeds validation payload limit.')
    }

    const prefix = this.#readUInt8()
    if (prefix <= 0x7F) return this.#writer.write(String(prefix))
    if (prefix >= 0xE0) return this.#writer.write(String(prefix - 0x01_00))
    if ((prefix & 0xE0) === 0xA0) return this.#writeString(prefix & 0x1F)
    if ((prefix & 0xF0) === 0x90) return this.#writeArray(prefix & 0x0F, depth)
    if ((prefix & 0xF0) === 0x80) return this.#writeMap(prefix & 0x0F, depth)

    switch (prefix) {
      case 0xC0: return this.#writer.write('null')
      case 0xC2: return this.#writer.write('false')
      case 0xC3: return this.#writer.write('true')
      case 0xC4: return this.#writeBinary(this.#readUInt8())
      case 0xC5: return this.#writeBinary(this.#read('readUInt16BE', 2))
      case 0xC6: return this.#writeBinary(this.#read('readUInt32BE', 4))
      case 0xCA: return this.#writeFloat(this.#read('readFloatBE', 4))
      case 0xCB: return this.#writeFloat(this.#read('readDoubleBE', 8))
      case 0xCC: return this.#writer.write(String(this.#readUInt8()))
      case 0xCD: return this.#writer.write(String(this.#read('readUInt16BE', 2)))
      case 0xCE: return this.#writer.write(String(this.#read('readUInt32BE', 4)))
      case 0xCF: return this.#writer.write(this.#read('readBigUInt64BE', 8).toString())
      case 0xD0: return this.#writer.write(String(this.#read('readInt8', 1)))
      case 0xD1: return this.#writer.write(String(this.#read('readInt16BE', 2)))
      case 0xD2: return this.#writer.write(String(this.#read('readInt32BE', 4)))
      case 0xD3: return this.#writer.write(this.#read('readBigInt64BE', 8).toString())
      case 0xD9: return this.#writeString(this.#readUInt8())
      case 0xDA: return this.#writeString(this.#read('readUInt16BE', 2))
      case 0xDB: return this.#writeString(this.#read('readUInt32BE', 4))
      case 0xDC: return this.#writeArray(this.#read('readUInt16BE', 2), depth)
      case 0xDD: return this.#writeArray(this.#read('readUInt32BE', 4), depth)
      case 0xDE: return this.#writeMap(this.#read('readUInt16BE', 2), depth)
      case 0xDF: return this.#writeMap(this.#read('readUInt32BE', 4), depth)
      default:
        throw new Error(`Unsupported MessagePack byte 0x${prefix.toString(16)} at offset ${this.#offset - 1}.`)
    }
  }

  /**
   * Writes one MessagePack array.
   *
   * @param {number} length array length
   * @param {number} depth current nesting depth
   */
  #writeArray (length, depth) {
    this.#assertCollectionLength(length)
    this.#writer.write('[')
    for (let index = 0; index < length; index++) {
      if (index > 0) this.#writer.write(',')
      this.#writeValue(depth + 1)
    }
    this.#writer.write(']')
  }

  /**
   * Writes one MessagePack map with JSON-compatible keys.
   *
   * @param {number} length map entry count
   * @param {number} depth current nesting depth
   */
  #writeMap (length, depth) {
    this.#assertCollectionLength(length)
    this.#writer.write('{')
    for (let index = 0; index < length; index++) {
      if (index > 0) this.#writer.write(',')
      this.#writeMapKey()
      this.#writer.write(':')
      this.#writeValue(depth + 1)
    }
    this.#writer.write('}')
  }

  /**
   * Writes a string or integer MessagePack map key as a JSON string.
   */
  #writeMapKey () {
    const prefix = this.#readUInt8()
    if (prefix <= 0x7F) return this.#writer.write(JSON.stringify(String(prefix)))
    if (prefix >= 0xE0) return this.#writer.write(JSON.stringify(String(prefix - 0x01_00)))
    if ((prefix & 0xE0) === 0xA0) return this.#writeString(prefix & 0x1F)

    let value
    switch (prefix) {
      case 0xCC: value = this.#readUInt8(); break
      case 0xCD: value = this.#read('readUInt16BE', 2); break
      case 0xCE: value = this.#read('readUInt32BE', 4); break
      case 0xCF: value = this.#read('readBigUInt64BE', 8); break
      case 0xD0: value = this.#read('readInt8', 1); break
      case 0xD1: value = this.#read('readInt16BE', 2); break
      case 0xD2: value = this.#read('readInt32BE', 4); break
      case 0xD3: value = this.#read('readBigInt64BE', 8); break
      case 0xD9: return this.#writeString(this.#readUInt8())
      case 0xDA: return this.#writeString(this.#read('readUInt16BE', 2))
      case 0xDB: return this.#writeString(this.#read('readUInt32BE', 4))
      default:
        throw new Error(`Unsupported MessagePack map key byte 0x${prefix.toString(16)}.`)
    }
    this.#writer.write(JSON.stringify(String(value)))
  }

  /**
   * Writes one UTF-8 MessagePack string.
   *
   * @param {number} length encoded byte length
   */
  #writeString (length) {
    if (length > MAX_STRING_BYTES) {
      throw new Error('MessagePack string exceeds validation payload limit.')
    }
    this.#assertAvailable(length)
    const end = this.#offset + length
    const value = this.#input.toString('utf8', this.#offset, end)
    this.#offset = end
    this.#writer.write(JSON.stringify(value))
  }

  /**
   * Writes one binary MessagePack value as a base64 JSON string.
   *
   * @param {number} length encoded byte length
   */
  #writeBinary (length) {
    this.#assertAvailable(length)
    const end = this.#offset + length
    const value = this.#input.subarray(this.#offset, end).toString('base64')
    this.#offset = end
    this.#writer.write(JSON.stringify(value))
  }

  /**
   * Writes one finite floating-point value.
   *
   * @param {number} value decoded floating-point value
   */
  #writeFloat (value) {
    if (!Number.isFinite(value)) throw new Error('MessagePack validation payload contains a non-finite number.')
    this.#writer.write(Object.is(value, -0) ? '-0' : String(value))
  }

  /**
   * Enforces per-collection and aggregate collection-entry limits.
   *
   * @param {number} length collection length
   */
  #assertCollectionLength (length) {
    if (length > MAX_COLLECTION_ENTRIES) {
      throw new Error(`MessagePack collection length ${length} exceeds validation entry limit.`)
    }
    this.#collectionEntries += length
    if (this.#collectionEntries > MAX_COLLECTION_ENTRIES) {
      throw new Error('MessagePack aggregate collection entries exceed validation limit.')
    }
    if (length > this.#input.length - this.#offset) {
      throw new Error(`MessagePack collection length ${length} exceeds remaining payload bytes.`)
    }
  }

  /**
   * Ensures the requested bytes remain in the input.
   *
   * @param {number} length byte count
   */
  #assertAvailable (length) {
    if (length < 0 || this.#offset + length > this.#input.length) {
      throw new Error('Unexpected end of MessagePack validation payload.')
    }
  }

  /** @returns {number} unsigned 8-bit integer */
  #readUInt8 () {
    this.#assertAvailable(1)
    return this.#input[this.#offset++]
  }

  /**
   * Reads one fixed-width numeric value.
   *
   * @param {keyof Buffer} method Buffer reader method
   * @param {number} bytes encoded width
   * @returns {number|bigint} decoded value
   */
  #read (method, bytes) {
    this.#assertAvailable(bytes)
    const value = this.#input[method](this.#offset)
    this.#offset += bytes
    return value
  }
}

module.exports = {
  MAX_COLLECTION_ENTRIES,
  MAX_INPUT_BYTES,
  MAX_NESTING_DEPTH,
  MAX_OUTPUT_BYTES,
  MAX_STRING_BYTES,
  msgpackToJson,
}
