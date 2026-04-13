'use strict'

const os = require('node:os')

const pkg = require('../../../../../package.json')

const { getAgentUrl } = require('../../agent/url')
const processTags = require('../../process-tags')
const { version: tracerVersion } = require('../../pkg')
const { Writer } = require('./writer')

class SpanStatsExporter {
  /**
   * @param {object} config
   * @param {string} [config.hostname]
   * @param {number} [config.port]
   * @param {object} [config.url]
   * @param {object} [config.tags]
   * @param {string} [config.env]
   * @param {string} [config.version]
   */
  constructor (config) {
    this._url = getAgentUrl(config)
    this._writer = new Writer({ url: this._url })
    this._hostname = os.hostname()
    this._env = config.env
    this._version = config.version
    this._tags = config.tags || {}
    this._sequence = 0
  }

  /**
   * Serializes drained bucket data into the Datadog /v0.6/stats payload format.
   *
   * @param {Array<{timeNs: number, bucket: Map}>} drained
   * @param {number} bucketSizeNs
   * @returns {object} Datadog stats payload
   */
  _serializeBuckets (drained, bucketSizeNs) {
    return {
      Hostname: this._hostname,
      Env: this._env,
      Version: this._version || tracerVersion,
      Stats: drained.map(({ timeNs, bucket }) => ({
        Start: timeNs,
        Duration: bucketSizeNs,
        Stats: Array.from(bucket.values(), s => s.toJSON()),
      })),
      Lang: 'javascript',
      TracerVersion: pkg.version,
      RuntimeID: this._tags['runtime-id'],
      Sequence: ++this._sequence,
      ProcessTags: processTags.serialized,
    }
  }

  /**
   * Exports drained bucket data to the Datadog stats endpoint.
   *
   * @param {Array<{timeNs: number, bucket: Map}>} drained
   * @param {number} bucketSizeNs
   */
  export (drained, bucketSizeNs) {
    const payload = this._serializeBuckets(drained, bucketSizeNs)
    this._writer.append(payload)
    this._writer.flush()
  }
}

module.exports = {
  SpanStatsExporter,
}
