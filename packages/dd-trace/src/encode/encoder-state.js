'use strict'

const util = require('./util')
const tokens = require('./tokens')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

class EncoderState {
  constructor (buffer, offset, trace, writer) {
    this.buffer = buffer
    this.offset = offset
    this.trace = trace
    this.writer = writer
  }

  checkOffset (offset, length) {
    const currentOffset = offset
    if (offset + length + (this.writer._stringsBufLen || 0) > MAX_SIZE) {
      if (this.offset === 5) {
        throw new RangeError('Trace is too big for payload.')
      }
      this.writer.flush()
      const currentBuffer = this.buffer
      this.buffer = this.writer._buffer
      offset = this.writer._offset
      offset = this.copy(offset, currentBuffer.slice(this.offset, currentOffset))
    }
    return offset
  }

  copy (offset, source) {
    const length = source.length

    offset = this.checkOffset(offset, length)
    this.buffer.set(source, offset)

    return offset + length
  }

  writePrefix (offset, length, tokens, startByte) {
    if (length <= 0xffff) {
      return this.copy(offset, tokens[length])
    }

    return offset +
      util.writeUInt8(this.buffer, startByte + 1, offset) +
      util.writeUInt32(this.buffer, length, offset + 1)
  }

  writeArrayPrefix (offset, array) {
    return this.writePrefix(offset, array.length, tokens.array, 0xdc)
  }

  writeMap (offset, map, write) {
    const keys = Object.keys(map)

    offset = this.copy(offset, tokens.map[keys.length])

    for (let i = 0, l = keys.length; i < l; i++) {
      offset = write(offset, keys[i])
      offset = write(offset, map[keys[i]])
    }

    return offset
  }
}

module.exports = EncoderState
