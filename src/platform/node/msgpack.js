'use strict'

const Buffer = require('safe-buffer').Buffer

module.exports = {
  prefix (count) {
    let buffer

    if (count <= 0xf) { // fixarray
      buffer = Buffer.alloc(1)
      buffer.fill(0x90 + count)
    } else if (count <= 0xffff) { // array 16
      buffer = Buffer.alloc(3)
      buffer.fill(0xdc, 0, 1)
      buffer.writeUInt16BE(count, 1)
    } else { // array 32
      buffer = Buffer.alloc(5)
      buffer.fill(0xdd, 0, 1)
      buffer.writeUInt32BE(count, 1)
    }

    return buffer
  }
}
