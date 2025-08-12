'use strict'

const Chunk = require('./chunk')

class MsgpackEncoder {
  encode (value) {
    const bytes = new Chunk()

    this.encodeValue(bytes, value)

    return bytes.buffer.subarray(0, bytes.length)
  }

  encodeValue (bytes, value) {
    switch (typeof value) {
      case 'bigint':
        this.encodeBigInt(bytes, value)
        break
      case 'boolean':
        this.encodeBoolean(bytes, value)
        break
      case 'number':
        this.encodeNumber(bytes, value)
        break
      case 'object':
        if (value === null) {
          this.encodeNull(bytes, value)
        } else if (Array.isArray(value)) {
          this.encodeArray(bytes, value)
        } else if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
          this.encodeBin(bytes, value)
        } else {
          this.encodeMap(bytes, value)
        }
        break
      case 'string':
        this.encodeString(bytes, value)
        break
      case 'symbol':
        this.encodeString(bytes, value.toString())
        break
      default: // function, symbol, undefined
        this.encodeNull(bytes, value)
        break
    }
  }

  encodeNull (bytes) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.buffer[offset] = 0xC0
  }

  encodeBoolean (bytes, value) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.buffer[offset] = value ? 0xC3 : 0xC2
  }

  encodeString (bytes, value) {
    bytes.write(value)
  }

  encodeFixArray (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.buffer[offset] = 0x90 + size
  }

  encodeArrayPrefix (bytes, value) {
    const length = value.length
    const offset = bytes.length

    bytes.reserve(5)
    bytes.buffer[offset] = 0xDD
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length
  }

  encodeArray (bytes, value) {
    if (value.length < 16) {
      this.encodeFixArray(bytes, value.length)
    } else {
      this.encodeArrayPrefix(bytes, value)
    }

    for (const item of value) {
      this.encodeValue(bytes, item)
    }
  }

  encodeFixMap (bytes, size = 0) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.buffer[offset] = 0x80 + size
  }

  encodeMapPrefix (bytes, keysLength) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.buffer[offset] = 0xDF
    bytes.buffer[offset + 1] = keysLength >> 24
    bytes.buffer[offset + 2] = keysLength >> 16
    bytes.buffer[offset + 3] = keysLength >> 8
    bytes.buffer[offset + 4] = keysLength
  }

  encodeByte (bytes, value) {
    bytes.reserve(1)
    bytes.buffer[bytes.length - 1] = value
  }

  encodeBin (bytes, value) {
    const offset = bytes.length

    if (value.byteLength < 256) {
      bytes.reserve(2)
      bytes.buffer[offset] = 0xC4
      bytes.buffer[offset + 1] = value.byteLength
    } else if (value.byteLength < 65_536) {
      bytes.reserve(3)
      bytes.buffer[offset] = 0xC5
      bytes.buffer[offset + 1] = value.byteLength >> 8
      bytes.buffer[offset + 2] = value.byteLength
    } else {
      bytes.reserve(5)
      bytes.buffer[offset] = 0xC6
      bytes.buffer[offset + 1] = value.byteLength >> 24
      bytes.buffer[offset + 2] = value.byteLength >> 16
      bytes.buffer[offset + 3] = value.byteLength >> 8
      bytes.buffer[offset + 4] = value.byteLength
    }

    bytes.set(value)
  }

  encodeInteger (bytes, value) {
    const offset = bytes.length

    bytes.reserve(5)
    bytes.buffer[offset] = 0xCE
    bytes.buffer[offset + 1] = value >> 24
    bytes.buffer[offset + 2] = value >> 16
    bytes.buffer[offset + 3] = value >> 8
    bytes.buffer[offset + 4] = value
  }

  encodeShort (bytes, value) {
    const offset = bytes.length

    bytes.reserve(3)
    bytes.buffer[offset] = 0xCD
    bytes.buffer[offset + 1] = value >> 8
    bytes.buffer[offset + 2] = value
  }

  encodeLong (bytes, value) {
    const offset = bytes.length
    const hi = (value / 2 ** 32) >> 0
    const lo = value >>> 0

    bytes.reserve(9)
    bytes.buffer[offset] = 0xCF
    bytes.buffer[offset + 1] = hi >> 24
    bytes.buffer[offset + 2] = hi >> 16
    bytes.buffer[offset + 3] = hi >> 8
    bytes.buffer[offset + 4] = hi
    bytes.buffer[offset + 5] = lo >> 24
    bytes.buffer[offset + 6] = lo >> 16
    bytes.buffer[offset + 7] = lo >> 8
    bytes.buffer[offset + 8] = lo
  }

  encodeNumber (bytes, value) {
    if (Number.isNaN(value)) {
      value = 0
    }
    if (Number.isInteger(value)) {
      if (value >= 0) {
        this.encodeUnsigned(bytes, value)
      } else {
        this.encodeSigned(bytes, value)
      }
    } else {
      this.encodeFloat(bytes, value)
    }
  }

  encodeSigned (bytes, value) {
    const offset = bytes.length

    if (value >= -0x20) {
      bytes.reserve(1)
      bytes.buffer[offset] = value
    } else if (value >= -0x80) {
      bytes.reserve(2)
      bytes.buffer[offset] = 0xD0
      bytes.buffer[offset + 1] = value
    } else if (value >= -0x80_00) {
      bytes.reserve(3)
      bytes.buffer[offset] = 0xD1
      bytes.buffer[offset + 1] = value >> 8
      bytes.buffer[offset + 2] = value
    } else if (value >= -0x80_00_00_00) {
      bytes.reserve(5)
      bytes.buffer[offset] = 0xD2
      bytes.buffer[offset + 1] = value >> 24
      bytes.buffer[offset + 2] = value >> 16
      bytes.buffer[offset + 3] = value >> 8
      bytes.buffer[offset + 4] = value
    } else {
      const hi = Math.floor(value / 2 ** 32)
      const lo = value >>> 0

      bytes.reserve(9)
      bytes.buffer[offset] = 0xD3
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

  encodeUnsigned (bytes, value) {
    const offset = bytes.length

    if (value <= 0x7F) {
      bytes.reserve(1)
      bytes.buffer[offset] = value
    } else if (value <= 0xFF) {
      bytes.reserve(2)
      bytes.buffer[offset] = 0xCC
      bytes.buffer[offset + 1] = value
    } else if (value <= 0xFF_FF) {
      bytes.reserve(3)
      bytes.buffer[offset] = 0xCD
      bytes.buffer[offset + 1] = value >> 8
      bytes.buffer[offset + 2] = value
    } else if (value <= 0xFF_FF_FF_FF) {
      bytes.reserve(5)
      bytes.buffer[offset] = 0xCE
      bytes.buffer[offset + 1] = value >> 24
      bytes.buffer[offset + 2] = value >> 16
      bytes.buffer[offset + 3] = value >> 8
      bytes.buffer[offset + 4] = value
    } else {
      const hi = (value / 2 ** 32) >> 0
      const lo = value >>> 0

      bytes.reserve(9)
      bytes.buffer[offset] = 0xCF
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

  // TODO: Support BigInt larger than 64bit.
  encodeBigInt (bytes, value) {
    const offset = bytes.length

    bytes.reserve(9)

    if (value >= 0n) {
      bytes.buffer[offset] = 0xCF
      bytes.view.setBigUint64(offset + 1, value)
    } else {
      bytes.buffer[offset] = 0xD3
      bytes.view.setBigInt64(offset + 1, value)
    }
  }

  encodeMap (bytes, value) {
    const keys = Object.keys(value)

    this.encodeMapPrefix(bytes, keys.length)

    for (const key of keys) {
      this.encodeValue(bytes, key)
      this.encodeValue(bytes, value[key])
    }
  }

  encodeFloat (bytes, value) {
    const offset = bytes.length

    bytes.reserve(9)
    bytes.buffer[offset] = 0xCB
    bytes.view.setFloat64(offset + 1, value)
  }
}

module.exports = { MsgpackEncoder }
