'use strict'

const { URL, format } = require('url')
const log = require('../../log')
const defaults = require('../../config/defaults')

/**
 * NativeExporter sends spans to the Datadog agent using native Rust code.
 *
 * Instead of formatting spans in JS and sending via HTTP, this exporter
 * delegates to the native NativeSpansInterface which handles serialization
 * and HTTP transport in Rust for improved performance.
 *
 * Key differences from AgentExporter:
 * - Receives raw span objects (not pre-formatted)
 * - Uses native TraceExporter for HTTP transport
 * - Batches spans by span ID for efficient export
 */
class NativeExporter {
  #timer
  #flushInFlight = false

  /**
   * @param {Object} config - Tracer configuration
   * @param {Object} prioritySampler - Priority sampler instance
   * @param {import('../../native/native_spans')} nativeSpans - NativeSpansInterface instance
   */
  constructor (config, prioritySampler, nativeSpans) {
    this._config = config
    this._prioritySampler = prioritySampler
    this._nativeSpans = nativeSpans
    this._pendingSpans = []

    const { url, hostname = defaults.hostname, port } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname,
      port
    }))

    process.once('beforeExit', () => {
      this.flush()
    })
  }

  /**
   * Update the agent URL.
   * @param {string|URL} url - New agent URL
   */
  setUrl (url) {
    try {
      this._url = new URL(url)
      // Reinitialize native state with new URL
      this._nativeSpans.setAgentUrl(this._url.toString())
    } catch (e) {
      log.warn(e.stack)
    }
  }

  /**
   * Export spans to the agent.
   *
   * In native mode, we receive raw span objects (not formatted) and collect
   * them for batch export. The native side handles serialization.
   *
   * @param {Array<Object>} spans - Array of span objects to export
   */
  export (spans) {
    // Collect spans for batch export
    for (const span of spans) {
      this._pendingSpans.push(span)
    }

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  /**
   * Flush pending spans to the agent.
   *
   * @param {Function} [done] - Callback when flush completes
   */
  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (this._pendingSpans.length === 0) {
      done()
      return
    }

    // Don't prepare a new chunk while a send is in flight — the prepared
    // spans would accumulate in native memory. Buffer them in JS instead
    // and flush when the in-flight send completes.
    if (this.#flushInFlight) {
      done()
      return
    }

    const spans = this._pendingSpans
    this._pendingSpans = []

    // Determine if first span is local root (for trace chunk header)
    const firstIsLocalRoot = this.#isLocalRoot(spans[0])

    // Add trace-level tags to the first span in the chunk
    // This matches the behavior in span_format.js extractChunkTags()
    if (firstIsLocalRoot && spans.length > 0) {
      this.#syncTraceTags(spans[0])
    }

    // Collect slot indices for native export
    // Note: flushChangeQueue is called inside flushSpans, no need to call it here
    const slots = spans.map(span => span.context()._slotIndex)

    // prepareChunk is synchronous — extract spans from native storage now.
    // sendPreparedChunk is async (HTTP send). We serialize sends so that
    // prepared chunks don't accumulate faster than they can be sent, which
    // would cause unbounded memory growth proportional to total requests.
    this._nativeSpans.flushSpans(slots, firstIsLocalRoot)
      .then(() => {
        this.#flushInFlight = false
        this._nativeSpans.freeSlots(slots)
        // If spans arrived while the send was in flight, flush them now
        if (this._pendingSpans.length > 0) {
          this.flush()
        }
      }, (err) => {
        this.#flushInFlight = false
        this._nativeSpans.freeSlots(slots)
        log.error('Error sending spans to agent via native exporter:', err)
      })
    this.#flushInFlight = true
    done()
  }

  /**
   * Sync trace-level tags to a span.
   * Trace tags are stored on the trace object and should be added to the
   * first span in each trace chunk, matching span_format.js behavior.
   *
   * @param {Object} span - The first span in the chunk
   */
  #syncTraceTags (span) {
    const context = span.context()
    const traceTags = context._trace?.tags

    if (!traceTags) return

    // Add each trace tag to the span's tags
    // This uses the span's tag proxy which syncs to native storage
    for (const [key, value] of Object.entries(traceTags)) {
      if (value !== undefined && value !== null) {
        // Don't overwrite existing span tags
        if (!context.hasTag(key)) {
          context.setTag(key, value)
        }
      }
    }
  }

  /**
   * Check if a span is a local root span.
   *
   * A local root span is either:
   * - A true root span (no parent)
   * - A span whose parent is from a different service/process
   *
   * @param {Object} span - Span to check
   * @returns {boolean}
   */
  #isLocalRoot (span) {
    if (!span) return true

    const context = span.context()

    // No parent means it's a root span
    if (!context._parentId) return true

    // Check if parent was remote (from context propagation)
    // In that case, this span is the local root
    if (context._isRemote) return true

    // Check if this is the first span in the trace's started array
    const trace = context._trace
    if (trace && trace.started.length > 0) {
      const firstSpan = trace.started[0]
      if (firstSpan === span) return true
    }

    return false
  }
}

module.exports = NativeExporter
