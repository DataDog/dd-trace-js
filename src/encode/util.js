'use strict'

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

module.exports = {
  writeUInt8,
  writeUInt16,
  writeUInt32
}
