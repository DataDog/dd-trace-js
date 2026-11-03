'use strict'

const { incrementCountMetric, TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION } = require('../../ci-visibility/telemetry')

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
    this._url = tracerConfig.url
  }

  export (trace) {
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    this._export(trace)
  }

  _export (payload, writer = this._writer, timerKey = '_timer', deferImmediateFlush = false) {
    const appended = writer.append(payload)
    if (this._config.isCiVisibility && appended !== false) {
      incrementCountMetric(TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION, {}, payload.length)
    }

    const { flushInterval } = this._config

    if (flushInterval === 0 && !deferImmediateFlush) {
      writer.flush()
    } else if (flushInterval !== 0 && this[timerKey] === undefined) {
      this[timerKey] = setTimeout(() => {
        writer.flush()
        this[timerKey] = undefined
      }, flushInterval)
      this[timerKey].unref?.()
    }

    return appended
  }

  getUncodedTraces () {
    return this._traceBuffer
  }

  exportUncodedTraces () {
    for (const uncodedTrace of this.getUncodedTraces()) {
      this.export(uncodedTrace)
    }
    this.resetUncodedTraces()
  }

  resetUncodedTraces () {
    this._traceBuffer = []
  }
}

module.exports = BufferingExporter
