'use strict'

const { AgentEncoder } = require('./0.4')

const {
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_TYPE_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME,
} = require('./tags-processors')

function truncate (value, maxLength, suffix = '') {
  if (!value) {
    return value
  }
  if (value.length > maxLength) {
    return `${value.slice(0, maxLength)}${suffix}`
  }
  return value
}

class SpanStatsEncoder extends AgentEncoder {
  makePayload () {
    const traceSize = this._traceBytes.length
    const buffer = Buffer.allocUnsafe(traceSize)
    this._traceBytes.copy(buffer, 0, traceSize)
    this._reset()
    return buffer
  }

  _encodeStat (bytes, stat) {
    bytes.writeMapPrefix(15)

    this._encodeString(bytes, 'Service')
    const service = stat.Service || DEFAULT_SERVICE_NAME
    this._encodeString(bytes, truncate(service, MAX_SERVICE_LENGTH))

    this._encodeString(bytes, 'Name')
    const name = stat.Name || DEFAULT_SPAN_NAME
    this._encodeString(bytes, truncate(name, MAX_NAME_LENGTH))

    this._encodeString(bytes, 'Resource')
    this._encodeString(bytes, truncate(stat.Resource, MAX_RESOURCE_NAME_LENGTH, '...'))

    this._encodeString(bytes, 'HTTPStatusCode')
    bytes.writeInteger(stat.HTTPStatusCode)

    this._encodeString(bytes, 'Type')
    this._encodeString(bytes, truncate(stat.Type, MAX_TYPE_LENGTH))

    this._encodeString(bytes, 'Hits')
    bytes.writeLong(stat.Hits)

    this._encodeString(bytes, 'Errors')
    bytes.writeLong(stat.Errors)

    this._encodeString(bytes, 'Duration')
    bytes.writeLong(stat.Duration)

    this._encodeString(bytes, 'OkSummary')
    bytes.writeBin(stat.OkSummary)

    this._encodeString(bytes, 'ErrorSummary')
    bytes.writeBin(stat.ErrorSummary)

    this._encodeString(bytes, 'Synthetics')
    bytes.writeBoolean(stat.Synthetics)

    this._encodeString(bytes, 'TopLevelHits')
    bytes.writeLong(stat.TopLevelHits)

    this._encodeString(bytes, 'HTTPMethod')
    this._encodeString(bytes, stat.HTTPMethod)

    this._encodeString(bytes, 'HTTPEndpoint')
    this._encodeString(bytes, stat.HTTPEndpoint)

    this._encodeString(bytes, 'srv_src')
    this._encodeString(bytes, stat.srv_src || '')
  }

  _encodeBucket (bytes, bucket) {
    bytes.writeMapPrefix(3)

    this._encodeString(bytes, 'Start')
    bytes.writeLong(bucket.Start)

    this._encodeString(bytes, 'Duration')
    bytes.writeLong(bucket.Duration)

    this._encodeString(bytes, 'Stats')
    bytes.writeArrayPrefix(bucket.Stats)
    for (const stat of bucket.Stats) {
      this._encodeStat(bytes, stat)
    }
  }

  _encode (bytes, stats) {
    bytes.writeMapPrefix(stats.ProcessTags ? 9 : 8)

    this._encodeString(bytes, 'Hostname')
    this._encodeString(bytes, stats.Hostname)

    this._encodeString(bytes, 'Env')
    this._encodeString(bytes, stats.Env)

    this._encodeString(bytes, 'Version')
    this._encodeString(bytes, stats.Version)

    this._encodeString(bytes, 'Stats')
    bytes.writeArrayPrefix(stats.Stats)
    for (const bucket of stats.Stats) {
      this._encodeBucket(bytes, bucket)
    }

    this._encodeString(bytes, 'Lang')
    this._encodeString(bytes, stats.Lang)

    this._encodeString(bytes, 'TracerVersion')
    this._encodeString(bytes, stats.TracerVersion)

    this._encodeString(bytes, 'RuntimeID')
    this._encodeString(bytes, stats.RuntimeID)

    this._encodeString(bytes, 'Sequence')
    bytes.writeLong(stats.Sequence)

    if (stats.ProcessTags) {
      this._encodeString(bytes, 'ProcessTags')
      this._encodeString(bytes, stats.ProcessTags)
    }
  }
}

module.exports = {
  SpanStatsEncoder,
}
