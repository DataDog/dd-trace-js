'use strict'

const log = require('./log')

/**
 * @typedef {(done: () => void) => void | Promise<void>} TelemetryFlusher
 */

/** @type {Set<TelemetryFlusher>} */
const telemetryFlushers = new Set()

/**
 * Registers a configured telemetry pipeline so serverless lifecycle retention
 * waits for its final export alongside trace delivery.
 * @param {TelemetryFlusher} flusher
 * @returns {() => void} Removes this pipeline when its provider is replaced.
 */
function registerTelemetryFlusher (flusher) {
  telemetryFlushers.add(flusher)
  // Avoid retaining a replaced provider or flushing it alongside the new one.
  return () => telemetryFlushers.delete(flusher)
}

/**
 * Flushes the trace exporter and every registered telemetry pipeline.
 * @param {{
 *   _exporter?: { flush?: TelemetryFlusher },
 *   _processor?: { _stats?: { forceFlush?: TelemetryFlusher } }
 * }|undefined} tracer
 * @param {() => void} [done]
 * @param {{ timeout?: number }} [options]
 */
function flushAll (tracer, done, options) {
  const traceExporter = tracer?._exporter
  const traceFlusher = traceExporter?.flush
  const spanStatsFlusher = tracer?._processor?._stats?.forceFlush
  let pending = telemetryFlushers.size +
    (typeof traceFlusher === 'function' ? 1 : 0) +
    (typeof spanStatsFlusher === 'function' ? 1 : 0)
  let completed = false
  let timeout

  const finish = () => {
    if (completed) return
    completed = true
    clearTimeout(timeout)
    done?.()
  }
  const complete = () => {
    if (--pending === 0) finish()
  }

  if (pending === 0) return finish()
  if (options?.timeout) {
    timeout = setTimeout(() => {
      log.warn('Timed out waiting for telemetry flush after %dms', options.timeout)
      finish()
    }, options.timeout)
  }

  const flush = flusher => {
    let flushed = false
    const onFlushed = error => {
      if (flushed) return
      flushed = true
      if (error) log.error('Error flushing telemetry pipeline:', error)
      complete()
    }
    try {
      const result = flusher(onFlushed)
      result?.then(onFlushed, error => onFlushed(error))
    } catch (error) {
      onFlushed(error)
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
