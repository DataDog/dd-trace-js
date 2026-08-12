'use strict'

/**
 * @typedef {(done: () => void) => void | Promise<void>} TelemetryFlusher
 */

/** @type {Set<TelemetryFlusher>} */
const telemetryFlushers = new Set()

/**
 * Registers a configured telemetry pipeline for lifecycle flushing.
 * @param {TelemetryFlusher} flusher
 * @returns {() => void} Removes the telemetry flusher.
 */
function registerTelemetryFlusher (flusher) {
  telemetryFlushers.add(flusher)
  return () => telemetryFlushers.delete(flusher)
}

/**
 * Flushes the trace exporter and every registered telemetry pipeline.
 * @param {{
 *   _exporter?: { flush?: TelemetryFlusher },
 *   _processor?: { _stats?: { forceFlush?: TelemetryFlusher } }
 * }|undefined} tracer
 * @param {() => void} [done]
 */
function flushAll (tracer, done) {
  const traceExporter = tracer?._exporter
  const traceFlusher = traceExporter?.flush
  const spanStatsFlusher = tracer?._processor?._stats?.forceFlush
  let pending = telemetryFlushers.size +
    (typeof traceFlusher === 'function' ? 1 : 0) +
    (typeof spanStatsFlusher === 'function' ? 1 : 0)
  if (pending === 0) return done?.()

  const complete = () => {
    if (--pending === 0) done?.()
  }

  const flush = flusher => {
    let flushed = false
    const onFlushed = () => {
      if (flushed) return
      flushed = true
      complete()
    }
    try {
      const result = flusher(onFlushed)
      result?.then(onFlushed, onFlushed)
    } catch {
      onFlushed()
    }
  }

  if (typeof traceFlusher === 'function') {
    flush(done => traceFlusher.call(traceExporter, done))
  }
  if (typeof spanStatsFlusher === 'function') {
    flush(done => spanStatsFlusher.call(tracer._processor._stats, done))
  }
  for (const flusher of telemetryFlushers) flush(flusher)
}

module.exports = { flushAll, registerTelemetryFlusher }
