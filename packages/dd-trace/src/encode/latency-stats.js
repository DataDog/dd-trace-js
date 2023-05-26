'use strict'

const { AgentEncoder } = require('./0.4')
const gzip = require('gzip-js'),
	options = { level: 1 };

const {
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
} = require('./tags-processors')

class LatencyStatsEncoder extends AgentEncoder {
  _encodeBool (bytes, value) {
    this._encodeByte(bytes, value ? 0xc3 : 0xc2)
  }

  makePayload () {
    const traceSize = this._traceBytes.length
    const buffer = Buffer.allocUnsafe(traceSize)
    this._traceBytes.copy(buffer, 0, traceSize)
    this._reset()
    return buffer
  }

  _encodeMapPrefix (bytes, length) {
    const offset = bytes.length

    bytes.reserve(1)
    bytes.length += 1

    bytes.buffer[offset] = 0x80 + length
  }

  _encodeBuffer (bytes, buffer) {
    const length = buffer.length
    const offset = bytes.length

    bytes.reserve(5)
    bytes.length += 5

    bytes.buffer[offset] = 0xc6
    bytes.buffer[offset + 1] = length >> 24
    bytes.buffer[offset + 2] = length >> 16
    bytes.buffer[offset + 3] = length >> 8
    bytes.buffer[offset + 4] = length

    buffer.copy(bytes.buffer, offset + 5)
    bytes.length += length
  }

  _encodeStat (bytes, stat) {
    this._encodeMapPrefix(bytes, 12)

    this._encodeString(bytes, 'Hash')
    this._encodeBuffer(bytes, stat.Hash)

    this._encodeString(bytes, 'ParentHash')
    this._encodeBuffer(bytes, stat.ParentHash)

    this._encodeString(bytes, 'EdgeTags')
    this._encodeArrayPrefix(bytes, stat.EdgeTags)
    for (const tag of stat.EdgeTags) {
      this._encodeString(bytes, tag)
    }

    this._encodeString(bytes, 'EdgeLatency')
    this._encodeBuffer(bytes, stat.EdgeLatency)

    this._encodeString(bytes, 'PathwayLatency')
    this._encodeBuffer(bytes, stat.PathwayLatency)
  }

  _encodeBucket (bytes, bucket) {
    this._encodeMapPrefix(bytes, 3)

    this._encodeString(bytes, 'Start')
    this._encodeLong(bytes, bucket.Start)

    this._encodeString(bytes, 'Duration')
    this._encodeLong(bytes, bucket.Duration)

    this._encodeString(bytes, 'Stats')
    this._encodeArrayPrefix(bytes, bucket.Stats)
    for (const stat of bucket.Stats) {
      this._encodeStat(bytes, stat)
    }
  }

  _encode (bytes, stats) {
    this._encodeMapPrefix(bytes, 6)

    this._encodeString(bytes, 'Env')
    this._encodeString(bytes, stats.Env)

    this._encodeString(bytes, 'Service')
    this._encodeString(bytes, stats.Service)

    this._encodeString(bytes, 'PrimaryTag')
    this._encodeMap(bytes, stats.PrimaryTag)

    this._encodeString(bytes, 'Stats')
    this._encodeArrayPrefix(bytes, stats.Stats)
    for (const bucket of stats.Stats) {
      this._encodeBucket(bytes, bucket)
    }

    this._encodeString(bytes, 'TracerVersion')
    this._encodeString(bytes, stats.TracerVersion)

    this._encodeString(bytes, 'Lang')
    this._encodeString(bytes, stats.Lang)
  }
}

module.exports = {
  LatencyStatsEncoder
}
