'use strict'

const log = require('./log')
const { supportsServerlessTelemetryRetention } = require('./serverless')

/**
 * @typedef {(done: () => void) => void} TelemetryFlusher
 */

/** @type {Set<TelemetryFlusher>} */
const telemetryFlushers = new Set()
const postTraceTelemetryFlushers = new Set()

/**
 * @typedef {{
 *   trace?: TelemetryFlusher,
 *   spanStats?: TelemetryFlusher
 * }} TraceFlushers
 */

/**
 * Registers a configured telemetry pipeline so serverless lifecycle retention
 * waits for its final export alongside trace delivery.
 * @param {TelemetryFlusher} flusher
 * @param {{ afterTrace?: boolean }} [options]
 * @returns {() => void} Removes this pipeline when its provider is replaced.
 */
function registerTelemetryFlusher (flusher, options) {
  if (!supportsServerlessTelemetryRetention()) return () => {}

  const flushers = options?.afterTrace ? postTraceTelemetryFlushers : telemetryFlushers
  flushers.add(flusher)
  // Avoid retaining a replaced provider or flushing it alongside the new one.
  return () => flushers.delete(flusher)
}

/**
 * Coordinates the configured telemetry flushers for a serverless lifecycle.
 *
 * Trace-owned flushers are supplied by DatadogTracer so this module does not
 * depend on its private implementation details.
 * @param {() => void} [done]
 * @param {{ timeout?: number }} [options]
 * @param {TraceFlushers} [traceFlushers]
 */
function flushServerlessTelemetry (done, options, traceFlushers = {}) {
  const { trace: traceFlusher, spanStats: spanStatsFlusher } = traceFlushers
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
      flusher(onFlushed)
    } catch (error) {
      onFlushed(error)
    }
  }

  if (typeof traceFlusher === 'function') {
    flush(traceFlusher, () => {
      for (const flusher of postTraceTelemetryFlushers) flush(flusher)
    })
  } else {
    for (const flusher of postTraceTelemetryFlushers) flush(flusher)
  }
  if (typeof spanStatsFlusher === 'function') {
    flush(spanStatsFlusher)
  }
  for (const flusher of telemetryFlushers) flush(flusher)
}

module.exports = { flushServerlessTelemetry, registerTelemetryFlusher }
