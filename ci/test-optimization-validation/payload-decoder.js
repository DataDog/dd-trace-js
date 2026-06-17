'use strict'

const zlib = require('zlib')

function decodeBody (body, headers) {
  const inflated = inflateIfNeeded(body, headers)
  const contentType = String(headers['content-type'] || '')

  if (contentType.includes('application/json') || looksLikeJson(inflated)) {
    return JSON.parse(inflated.toString('utf8'))
  }

  if (contentType.includes('application/msgpack')) {
    return decodeMsgpack(inflated)
  }

  return inflated.toString('utf8')
}

function inflateIfNeeded (body, headers) {
  const encoding = String(headers['content-encoding'] || '').toLowerCase()
  if (encoding === 'gzip') return zlib.gunzipSync(body)
  if (encoding === 'deflate') return zlib.inflateSync(body)
  return body
}

function looksLikeJson (body) {
  const trimmed = body.toString('utf8', 0, Math.min(body.length, 16)).trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function decodeMsgpack (buffer) {
  const decoder = new MsgpackDecoder(buffer)
  return decoder.decode()
}

class MsgpackDecoder {
  constructor (buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  decode () {
    return this.read()
  }

  read () {
    const byte = this.uint8()

    if (byte <= 0x7F) return byte
    if (byte >= 0xE0) return byte - 0x01_00
    if ((byte & 0xE0) === 0xA0) return this.string(byte & 0x1F)
    if ((byte & 0xF0) === 0x90) return this.array(byte & 0x0F)
    if ((byte & 0xF0) === 0x80) return this.map(byte & 0x0F)

    switch (byte) {
      case 0xC0: return null
      case 0xC2: return false
      case 0xC3: return true
      case 0xC4: return this.bin(this.uint8())
      case 0xC5: return this.bin(this.uint16())
      case 0xC6: return this.bin(this.uint32())
      case 0xCA: return this.float32()
      case 0xCB: return this.float64()
      case 0xCC: return this.uint8()
      case 0xCD: return this.uint16()
      case 0xCE: return this.uint32()
      case 0xCF: return this.uint64()
      case 0xD0: return this.int8()
      case 0xD1: return this.int16()
      case 0xD2: return this.int32()
      case 0xD3: return this.int64()
      case 0xD9: return this.string(this.uint8())
      case 0xDA: return this.string(this.uint16())
      case 0xDB: return this.string(this.uint32())
      case 0xDC: return this.array(this.uint16())
      case 0xDD: return this.array(this.uint32())
      case 0xDE: return this.map(this.uint16())
      case 0xDF: return this.map(this.uint32())
      default:
        throw new Error(`Unsupported msgpack byte 0x${byte.toString(16)} at offset ${this.offset - 1}`)
    }
  }

  array (length) {
    const value = []
    for (let i = 0; i < length; i++) value.push(this.read())
    return value
  }

  map (length) {
    const value = {}
    for (let i = 0; i < length; i++) {
      value[this.read()] = this.read()
    }
    return value
  }

  string (length) {
    const end = this.offset + length
    const value = this.buffer.toString('utf8', this.offset, end)
    this.offset = end
    return value
  }

  bin (length) {
    const end = this.offset + length
    const value = this.buffer.subarray(this.offset, end).toString('base64')
    this.offset = end
    return value
  }

  uint8 () {
    return this.buffer[this.offset++]
  }

  uint16 () {
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  uint32 () {
    const value = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    return value
  }

  uint64 () {
    const value = this.buffer.readBigUInt64BE(this.offset)
    this.offset += 8
    return normalizeBigInt(value)
  }

  int8 () {
    return this.buffer.readInt8(this.offset++)
  }

  int16 () {
    const value = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  int32 () {
    const value = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  int64 () {
    const value = this.buffer.readBigInt64BE(this.offset)
    this.offset += 8
    return normalizeBigInt(value)
  }

  float32 () {
    const value = this.buffer.readFloatBE(this.offset)
    this.offset += 4
    return value
  }

  float64 () {
    const value = this.buffer.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }
}

function normalizeBigInt (value) {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value)
  }
  return value.toString()
}

module.exports = { decodeBody, decodeMsgpack }
