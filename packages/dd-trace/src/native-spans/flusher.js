'use strict'

const log = require('../log')
const tracerVersion = require('../../../../package.json').version

const ADDON_PATH = './native/native_spans.node'

/**
 * Stand-in used when the crate has not been built. Every JS-side write path stays
 * measurable without `cargo` in the picture; the batch is simply dropped.
 */
class NoopFlusher {
  flush () {}
}

/**
 * @param {ArrayBuffer} events
 * @param {ArrayBuffer} doubles
 * @param {ArrayBuffer} strings
 * @param {ReturnType<import('../config')>} [config]
 * @returns {{ flush: (eventWords: number, doubleSlots: number, stringBytes: number) => void }}
 */
function createFlusher (events, doubles, strings, config) {
  let binding
  try {
    binding = require(ADDON_PATH)
  } catch (error) {
    // Spans are still written to the buffers and then dropped, so the JS write path
    // stays measurable on a checkout that has never run cargo.
    log.error('native-spans: %s missing; run npm run build:native-spans. Spans dropped: %s', ADDON_PATH, error.message)
    return new NoopFlusher()
  }

  return new binding.EventFlusher(
    new Uint32Array(events),
    new Float64Array(doubles),
    new Uint8Array(strings),
    {
      url: String(config?.url ?? 'http://127.0.0.1:8126'),
      tracerVersion,
      nodeVersion: process.version,
      // Whichever wire format the rest of the tracer was configured for; the native
      // encoder implements both.
      protocolVersion: String(config?.protocolVersion ?? '0.5'),
      flushMinSpans: config?.flushMinSpans ?? 1000,
    }
  )
}

module.exports = createFlusher
