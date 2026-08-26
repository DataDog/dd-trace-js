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
      // Node clamps setTimeout delays above its 32-bit signed maximum (2^31 - 1 ms)
      // to 1 ms, so a finite-but-overflowed interval would spin the re-arm below.
      // Only schedule when the interval fits the timer budget; the encoder size
      // gate and the final flush still deliver payloads for overflowed intervals.
      // A negative interval (accepted by the INT config parser) previously clamped
      // to a 1 ms timer; preserve that prompt-flush behavior by treating it as 0
      // rather than silently disabling the periodic flush.
      const canSchedule = flushInterval > 0 && flushInterval <= 2_147_483_647
      if (canSchedule || flushInterval < 0) {
        const scheduleFlush = () => {
          this[timerKey] = setTimeout(() => {
            // The periodic timer is a latency backstop; the encoder's size gate and the
            // final flush still deliver payloads. Subclasses can suppress it (e.g. while
            // the intake origin is saturated) so events coalesce instead of queueing.
            if (this._shouldFlush(writer)) {
              this[timerKey] = undefined
              writer.flush()
            } else if (canSchedule) {
              // Saturation suppressed the flush; re-arm so a buffered payload below the
              // encoder's size threshold is still delivered once the origin becomes idle,
              // rather than waiting indefinitely for another event.
              scheduleFlush()
            } else {
              // Non-schedulable interval (e.g. negative) suppressed by saturation: clear
              // the timer so a later export can re-schedule once the origin is idle.
              this[timerKey] = undefined
            }
          }, flushInterval)
          this[timerKey].unref?.()
        }
        scheduleFlush()
      }
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
