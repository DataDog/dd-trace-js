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
    if (this._config.isCiVisibility) {
      incrementCountMetric(TELEMETRY_EVENTS_ENQUEUED_FOR_SERIALIZATION, {}, payload.length)
    }
    const appended = writer.append(payload)

    const { flushInterval } = this._config

    if (flushInterval === 0 && !deferImmediateFlush) {
      writer.flush()
    } else if (flushInterval !== 0 && this[timerKey] === undefined) {
      const scheduleFlush = () => {
        this[timerKey] = setTimeout(() => {
          // The periodic timer is a latency backstop; the encoder's size gate and the
          // final flush still deliver payloads. Subclasses can suppress it (e.g. while
          // the intake origin is saturated) so events coalesce instead of queueing.
          if (this._shouldFlush(writer)) {
            this[timerKey] = undefined
            writer.flush()
          } else {
            // Saturation suppressed the flush; re-arm so a buffered payload below the
            // encoder's size threshold is still delivered once the origin becomes idle,
            // rather than waiting indefinitely for another event.
            scheduleFlush()
          }
        }, flushInterval)
        this[timerKey].unref?.()
      }
      scheduleFlush()
    }

    return appended
  }

  /**
   * Decides whether a periodic timer flush should fire. Defaults to `true`; Test
   * Optimization overrides it to hold flushes while the intake origin is busy.
   *
   * @param {object} _writer
   * @returns {boolean}
   */
  _shouldFlush (_writer) {
    return true
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
