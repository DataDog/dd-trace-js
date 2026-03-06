'use strict'

const { incrementCountMetric, TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION } = require('../../ci-visibility/telemetry')
const { getAgentUrl } = require('../../agent/url')

/**
 * Base exporter that buffers traces until a writer is initialized.
 * Provides common export logic with flush intervals.
 */
class BufferingExporter {
  #traceBuffer = []
  _isInitialized = false
  _writer
  _config

  constructor (tracerConfig) {
    this._config = tracerConfig
    this._url = getAgentUrl(tracerConfig)
  }

  export (trace) {
    if (!this._isInitialized) {
      this.#traceBuffer.push(trace)
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

  get _traceBuffer () {
    return this.#traceBuffer
  }

  getUncodedTraces () {
    return this.#traceBuffer
  }

  exportUncodedTraces () {
    for (const uncodedTrace of this.getUncodedTraces()) {
      this.export(uncodedTrace)
    }
    this.resetUncodedTraces()
  }

  resetUncodedTraces () {
    this.#traceBuffer = []
  }
}

module.exports = BufferingExporter
