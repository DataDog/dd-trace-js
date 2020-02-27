'use strict'

const { Int64BE } = require('int64-buffer') // TODO remove dependency

function writeUInt8 (buffer, value, offset) {
  buffer[offset] = value

  return 1
}

function writeUInt16 (buffer, value, offset) {
  buffer[offset + 1] = value & 255
  value = value >> 8
  buffer[offset + 0] = value & 255

  return 2
}

function writeUInt32 (buffer, value, offset) {
  buffer[offset + 3] = value & 255
  value = value >> 8
  buffer[offset + 2] = value & 255
  value = value >> 8
  buffer[offset + 1] = value & 255
  value = value >> 8
  buffer[offset + 0] = value & 255

  return 4
}

function writeInt64 (buffer, value, offset) {
  new Int64BE(buffer, offset, value) // eslint-disable-line no-new
  return 8
}

function write (buffer, string, offset) {
  let index = offset || (offset |= 0)
  const length = string.length
  let chr = 0
  let i = 0
  while (i < length) {
    chr = string.charCodeAt(i++)

    if (chr < 128) {
      buffer[index++] = chr
    } else if (chr < 0x800) {
      // 2 bytes
      buffer[index++] = 0xC0 | (chr >>> 6)
      buffer[index++] = 0x80 | (chr & 0x3F)
    } else if (chr < 0xD800 || chr > 0xDFFF) {
      // 3 bytes
      buffer[index++] = 0xE0 | (chr >>> 12)
      buffer[index++] = 0x80 | ((chr >>> 6) & 0x3F)
      buffer[index++] = 0x80 | (chr & 0x3F)
    } else {
      // 4 bytes - surrogate pair
      chr = (((chr - 0xD800) << 10) | (string.charCodeAt(i++) - 0xDC00)) + 0x10000
      buffer[index++] = 0xF0 | (chr >>> 18)
      buffer[index++] = 0x80 | ((chr >>> 12) & 0x3F)
      buffer[index++] = 0x80 | ((chr >>> 6) & 0x3F)
      buffer[index++] = 0x80 | (chr & 0x3F)
    }
  }
  return index - offset
}

module.exports = {
  writeUInt8,
  writeUInt16,
  writeUInt32,
  writeInt64,
  write
}
