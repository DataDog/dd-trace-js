'use strict'

const { Encoder: BaseEncoder } = require('./0.4')

const ARRAY_OF_TWO = 0x92
const ARRAY_OF_TWELVE = 0x9c

class Encoder extends BaseEncoder {
  makePayload () {
    const prefixSize = 1
    const stringSize = this._stringBytes.length + 5
    const traceSize = this._traceBytes.length + 5
    const buffer = Buffer.allocUnsafe(prefixSize + stringSize + traceSize)

    let offset = 0

    buffer[offset++] = ARRAY_OF_TWO

    offset = this._writeStrings(buffer, offset)
    offset = this._writeTraces(buffer, offset)

    this._reset()

    return buffer
  }

  _encode (bytes, spans) {
    this._encodeArrayPrefix(bytes, spans)

    for (const span of spans) {
      this._encodeByte(bytes, ARRAY_OF_TWELVE)
      this._encodeString(bytes, span.service)
      this._encodeString(bytes, span.name)
      this._encodeString(bytes, span.resource)
      this._encodeId(bytes, span.trace.traceId)
      this._encodeId(bytes, span.spanId)
      this._encodeId(bytes, span.parentId)
      this._encodeLong(bytes, span.start || 0)
      this._encodeLong(bytes, span.duration || 0)
      this._encodeInteger(bytes, span.error ? 1 : 0)
      this._encodeMeta(bytes, span)
      this._encodeMetrics(bytes, span)
      this._encodeString(bytes, span.type)
    }
  }

  _encodeString (bytes, value = '') {
    this._cacheString(value)
    this._encodeInteger(bytes, this._stringMap[value])
  }

  _cacheString (value) {
    if (!(value in this._stringMap)) {
      this._stringMap[value] = this._stringCount++
      this._stringBytes.write(value)
    }
  }

  _writeStrings (buffer, offset) {
    offset = this._writeArrayPrefix(buffer, offset, this._stringCount)
    offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length)

    return offset
  }
}

module.exports = { Encoder }
