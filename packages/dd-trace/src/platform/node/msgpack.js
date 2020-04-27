'use strict'

module.exports = {
  prefix (contents, count) {
    let start

    if (count <= 0xf) { // fixarray
      start = 4
      contents.fill(0x90 + count, 4, 5)
    } else if (count <= 0xffff) { // array 16
      start = 2
      contents.fill(0xdc, 2, 3)
      contents.writeUInt16BE(count, 3)
    } else { // array 32
      start = 0
      contents.fill(0xdd, 0, 1)
      contents.writeUInt32BE(count, 1)
    }

    return [contents.slice(start)]
  }
}
