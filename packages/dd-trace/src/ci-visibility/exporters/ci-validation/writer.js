'use strict'

const { AgentlessCiVisibilityEncoder } = require('../../../encode/agentless-ci-visibility')

class CiValidationWriter {
  /**
   * Creates an offline writer that preserves CI Visibility event encoding.
   *
   * @param {object} options writer options
   * @param {object} options.sink bounded validation sink
   * @param {object} options.tags tracer tags
   */
  constructor ({ sink, tags }) {
    const { 'runtime-id': runtimeId, env, service } = tags
    this._sink = sink
    this._encoder = new AgentlessCiVisibilityEncoder(this, { runtimeId, env, service })
  }

  /**
   * Encodes a CI Visibility trace without using an HTTP writer.
   *
   * @param {object[]} trace formatted trace
   */
  append (trace) {
    this._encoder.encode(trace)
  }

  /**
   * Flushes encoded events synchronously to an offline payload file.
   *
   * @param {Function} [done] completion callback
   */
  flush (done = () => {}) {
    if (this._encoder.count() > 0) {
      let payload
      try {
        payload = this._encoder.makePayload()
      } catch (error) {
        if (error.code !== 'ERR_MSGPACK_CHUNK_OVERFLOW') throw error
        this._encoder.reset()
        this._sink.recordError('output_payload_too_large')
        done()
        return
      }
      this._sink.writeTestCycle(payload)
    }
    done()
  }

  /**
   * Adds CI event metadata before the next payload is encoded.
   *
   * @param {object} tags metadata grouped by event type
   */
  addMetadataTags (tags) {
    this._encoder.addMetadataTags(tags)
  }
}

module.exports = CiValidationWriter
