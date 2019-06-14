'use strict'

const Buffer = require('safe-buffer').Buffer

module.exports = {
  prefix (array) {
    let buffer

    if (array.length <= 0xf) { // fixarray
      buffer = Buffer.alloc(1)
      buffer.fill(0x90 + array.length)
    } else if (array.length <= 0xffff) { // array 16
      buffer = Buffer.alloc(3)
      buffer.fill(0xdc, 0, 1)
      buffer.writeUInt16BE(array.length, 1)
    } else { // array 32
      buffer = Buffer.alloc(5)
      buffer.fill(0xdd, 0, 1)
      buffer.writeUInt32BE(array.length, 1)
    }

    return [buffer].concat(array)
  }
}
