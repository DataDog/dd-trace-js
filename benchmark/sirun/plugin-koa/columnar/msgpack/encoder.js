'use strict'

const float64Array = new Float64Array(1)
const uInt8Float64Array = new Uint8Array(float64Array.buffer)

float64Array[0] = -1

const bigEndian = uInt8Float64Array[7] === 0

class MsgpackEncoder {
  copy (bytes, value) {
    bytes.set(value)
  }

  encodeString (bytes, value) {
    bytes.write(value)
  }

  encodeFixArray (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x90 + size
  }

  encodeArrayPrefix (bytes, value) {
    const length = value.length
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xdd
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  encodeFixMap (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x80 + size
  }

  encodeMapPrefix (bytes, keysLength) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5
    bytes.buffer[offset] = 0xdf
    bytes.buffer[offset + 1] = keysLength >> 24
    bytes.buffer[offset + 2] = keysLength >> 16
    bytes.buffer[offset + 3] = keysLength >> 8
    bytes.buffer[offset + 4] = keysLength
  }

  encodeByte (bytes, value) {
    bytes.reserve(1)

    bytes.buffer[bytes.length++] = value
  }

  encodeBin (bytes, value) {
    const offset = bytes.length

    bytes.reserve(3)
    bytes.length += 3
    bytes.buffer[offset] = 0xc5
    bytes.buffer[offset + 1] = value.byteLength >> 8
    bytes.buffer[offset + 2] = value.byteLength
    bytes.set(value)
  }

  encodeInteger (bytes, value) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xce
    bytes.buffer[offset + 1] = value >> 24
    bytes.buffer[offset + 2] = value >> 16
    bytes.buffer[offset + 3] = value >> 8
    bytes.buffer[offset + 4] = value
  }

  encodeShort (bytes, value) {
    const offset = bytes.length

    bytes.reserve(3)
    bytes.length += 3

    bytes.buffer[offset] = 0xcd
    bytes.buffer[offset + 1] = value >> 8
    bytes.buffer[offset + 2] = value
  }

  encodeLong (bytes, value) {
    const offset = bytes.length
    const hi = (value / Math.pow(2, 32)) >> 0
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcf
    bytes.buffer[offset + 1] = hi >> 24
    bytes.buffer[offset + 2] = hi >> 16
    bytes.buffer[offset + 3] = hi >> 8
    bytes.buffer[offset + 4] = hi
    bytes.buffer[offset + 5] = lo >> 24
    bytes.buffer[offset + 6] = lo >> 16
    bytes.buffer[offset + 7] = lo >> 8
    bytes.buffer[offset + 8] = lo
  }

  encodeUnsigned (bytes, value) {
    const offset = bytes.length

    if (value <= 0x7f) {
      bytes.reserve(1)
      bytes.length += 1

      bytes.buffer[offset] = value
    } else if (value <= 0xff) {
      bytes.reserve(2)
      bytes.length += 2

      bytes.buffer[offset] = 0xcc
      bytes.buffer[offset + 1] = value
    } else if (value <= 0xffff) {
      bytes.reserve(3)
      bytes.length += 3

      bytes.buffer[offset] = 0xcd
      bytes.buffer[offset + 1] = value >> 8
      bytes.buffer[offset + 2] = value
    } else if (value <= 0xffffffff) {
      bytes.reserve(5)
      bytes.length += 5

      bytes.buffer[offset] = 0xce
      bytes.buffer[offset + 1] = value >> 24
      bytes.buffer[offset + 2] = value >> 16
      bytes.buffer[offset + 3] = value >> 8
      bytes.buffer[offset + 4] = value
    } else {
      const hi = (value / Math.pow(2, 32)) >> 0
      const lo = value >>> 0

      bytes.reserve(9)
      bytes.length += 9

      bytes.buffer[offset] = 0xcf
      bytes.buffer[offset + 1] = hi >> 24
      bytes.buffer[offset + 2] = hi >> 16
      bytes.buffer[offset + 3] = hi >> 8
      bytes.buffer[offset + 4] = hi
      bytes.buffer[offset + 5] = lo >> 24
      bytes.buffer[offset + 6] = lo >> 16
      bytes.buffer[offset + 7] = lo >> 8
      bytes.buffer[offset + 8] = lo
    }
  }

  encodeMap (bytes, value) {
    const keys = Object.keys(value)
    const validKeys = keys.filter(key => typeof value[key] === 'string' || typeof value[key] === 'number')

    this.encodeMapPrefix(bytes, validKeys.length)

    for (const key of validKeys) {
      this.encodeString(bytes, key)
      this.encodeValue(bytes, value[key])
    }
  }

  encodeValue (bytes, value) {
    switch (typeof value) {
      case 'string':
        this.encodeString(bytes, value)
        break
      case 'number':
        this.encodeFloat(bytes, value)
        break
      default:
        // should not happen
    }
  }

  encodeFloat (bytes, value) {
    float64Array[0] = value

    const offset = bytes.length
    bytes.reserve(9)
    bytes.length += 9

    bytes.buffer[offset] = 0xcb

    if (bigEndian) {
      for (let i = 0; i <= 7; i++) {
        bytes.buffer[offset + i + 1] = uInt8Float64Array[i]
      }
    } else {
      for (let i = 7; i >= 0; i--) {
        bytes.buffer[bytes.length - i - 1] = uInt8Float64Array[i]
      }
    }
  }
}

module.exports = { MsgpackEncoder }
