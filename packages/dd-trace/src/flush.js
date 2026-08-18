'use strict'

const log = require('./log')

/**
 * @typedef {(done: () => void) => void | Promise<void>} TelemetryFlusher
 */

/** @type {Set<TelemetryFlusher>} */
const telemetryFlushers = new Set()
const postTraceTelemetryFlushers = new Set()

/**
 * Registers a configured telemetry pipeline so serverless lifecycle retention
 * waits for its final export alongside trace delivery.
 * @param {TelemetryFlusher} flusher
 * @param {{ afterTrace?: boolean }} [options]
 * @returns {() => void} Removes this pipeline when its provider is replaced.
 */
function registerTelemetryFlusher (flusher, options) {
  const flushers = options?.afterTrace ? postTraceTelemetryFlushers : telemetryFlushers
  flushers.add(flusher)
  // Avoid retaining a replaced provider or flushing it alongside the new one.
  return () => flushers.delete(flusher)
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
  // TODO: Include DSM after DataStreamsProcessor exposes a completion-aware flush API.
  let pending = telemetryFlushers.size + postTraceTelemetryFlushers.size +
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

  const flush = (flusher, afterFlushed) => {
    let flushed = false
    const onFlushed = error => {
      if (flushed) return
      flushed = true
      if (error) log.error('Error flushing telemetry pipeline:', error)
      afterFlushed?.()
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
    flush(done => traceFlusher.call(traceExporter, done), () => {
      for (const flusher of postTraceTelemetryFlushers) flush(flusher)
    })
  } else {
    for (const flusher of postTraceTelemetryFlushers) flush(flusher)
  }
  if (typeof spanStatsFlusher === 'function') {
    flush(done => spanStatsFlusher.call(tracer._processor._stats, done))
  }
  for (const flusher of telemetryFlushers) flush(flusher)
}

module.exports = { flushAll, registerTelemetryFlusher }
