'use strict'

const { incrementCountMetric, TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION } = require('../../ci-visibility/telemetry')
const { getAgentUrl } = require('../../agent/url')

/**
 * Base exporter that buffers traces until a writer is initialized.
 * Provides common export logic with flush intervals.
 */
class BufferingExporter {
  _traceBuffer = []
  _isInitialized = false
  _writer

  constructor (tracerConfig) {
    this._config = tracerConfig
    this._url = getAgentUrl(tracerConfig)
  }

  export (trace) {
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    this._export(trace)
  }

  _export (payload, writer = this._writer, timerKey = '_timer') {
    if (this._config.isCiVisibility) {
      incrementCountMetric(TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION, {}, payload.length)
    }
    writer.append(payload)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      writer.flush()
    } else if (this[timerKey] === undefined) {
      this[timerKey] = setTimeout(() => {
        writer.flush()
        this[timerKey] = undefined
      }, flushInterval).unref()
    }
  }

  getUncodedTraces () {
    return this._traceBuffer
  }

  exportUncodedTraces () {
    this.getUncodedTraces().forEach(uncodedTrace => {
      this.export(uncodedTrace)
    })
    this.resetUncodedTraces()
  }

  resetUncodedTraces () {
    this._traceBuffer = []
  }
}

module.exports = BufferingExporter
