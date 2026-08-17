'use strict'

const { URL, format } = require('url')

const { channel } = require('dc-polyfill')

const defaults = require('../../config/defaults')
const { AgentEncoder } = require('../../encode/0.4')
const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const { fetchAgentInfo } = require('../../agent/info')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')

// Bound finalized span objects retained until the next batch flush.
const MAX_PENDING_SPANS = 2000

// Native sends mirror legacy exporter request/response/error health metrics.
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

// Lazy debug representation matching the legacy payload log.
/**
 * @param {object[]} spans Finalized spans
 * @returns {string}
 */
function formatSpansForDebug (spans) {
  try {
    return JSON.stringify(spans, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  } catch {
    // A pathological tag value (e.g. circular) must never throw out of export().
    return '[unserializable]'
  }
}

/**
 * Batches finalized spans and delegates serialization and transport to libdatadog.
 */
class NativeExporter {
  #nativeSpans
  #timer
  #flushInFlight = false
  #firstFlushSent = false
  #flushCallbacks = []
  #encoder
  #pendingPayloads = []
  #pendingSpanCount = 0
  #pendingTraces = []
  #urlUpdateCallbacks = []
  // Fatal native exporter construction errors cannot recover.
  #disabled = false
  /**
   * @param {object} config - Tracer configuration
   * @param {object} prioritySampler - Priority sampler instance
   * @param {import('../../native/native-spans')} nativeSpans - NativeSpansInterface instance
   */
  constructor (config, prioritySampler, nativeSpans) {
    this._config = config
    this._prioritySampler = prioritySampler
    this.#nativeSpans = nativeSpans
    const nativeSpanEvents = config.DD_TRACE_NATIVE_SPAN_EVENTS || config.OTEL_TRACES_EXPORTER === 'otlp'
    this.#encoder = new AgentEncoder({ flush: () => this.#stageEncodedPayload() }, undefined, nativeSpanEvents)
    this._writer = { flush: this.#flushWithStats.bind(this) }

    const { url, hostname = defaults.hostname, port } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname,
      port,
    }))

    // OTLP takes precedence over explicit, capability-gated v0.5 output.
    if (config.OTEL_TRACES_EXPORTER === 'otlp') {
      this.#configureOtlp()
    } else if (config.protocolVersion === '0.5') {
      this.#negotiateV05()
    }

    // Use the shared registry to avoid per-tracer process listeners. Flush
    // traces before stats because chunk preparation feeds the concentrator.
    const finalFlush = () => {
      this.flush(() => {
        this.flushStats().catch((error) => {
          log.warn('Failed final native stats flush on exit: %s', error)
        })
      })
    }
    const handlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
    if (handlers) {
      handlers.add(finalFlush)
    } else {
      process.once('beforeExit', finalFlush)
    }
  }

  /**
   * Apply resolved OTLP configuration before the first native send.
   */
  #configureOtlp () {
    const config = this._config
    const endpoint = config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    if (!endpoint) {
      // No endpoint means the native exporter must remain on the agent path.
      log.warn('Native exporter: OTEL_TRACES_EXPORTER=otlp but no OTLP traces endpoint resolved; skipping OTLP setup')
      return
    }
    // Invalid endpoints fail loudly during native exporter construction.
    this.#nativeSpans.setOtlpEndpoint(endpoint)

    const protocol = config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    if (protocol) {
      try {
        this.#nativeSpans.setOtlpProtocol(protocol)
      } catch (error) {
        // Unsupported protocols fall back to the native default.
        log.warn('Native exporter: unsupported OTLP protocol %s, using default: %s', protocol, error.message)
      }
    }

    // Flatten parsed headers for the binding API.
    const headers = config.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    if (headers && typeof headers === 'object') {
      const flat = []
      for (const [key, value] of Object.entries(headers)) {
        flat.push(key, String(value))
      }
      if (flat.length > 0) {
        this.#nativeSpans.setOtlpHeaders(flat)
      }
    }
  }

  /**
   * Enable v0.5 only when the agent advertises it before the first send.
   */
  #negotiateV05 () {
    let infoUrl
    try {
      infoUrl = typeof this._url === 'string' ? new URL(this._url) : this._url
    } catch (error) {
      log.warn('Native exporter: cannot parse agent URL for /info v0.5 check: %s', error.message)
      return
    }
    fetchAgentInfo(infoUrl, (error, info) => {
      if (error) {
        log.debug('Native exporter: /info fetch failed, staying on v0.4: %s', error.message)
        return
      }
      // `endpoints` is untrusted agent input: guard the type so a malformed
      // response (non-array, or a string that substring-matches) can't throw
      // in this async callback or false-positive into v0.5.
      if (Array.isArray(info?.endpoints) && info.endpoints.includes('/v0.5/traces')) {
        this.#nativeSpans.setUseV05(true)
      }
    })
  }

  #finishUrlUpdateCallbacks () {
    if (this.#urlUpdateCallbacks.length === 0) return
    if (this.#flushInFlight) return
    if (this.#hasPendingWork()) {
      this.flush()
      return
    }

    const callbacks = this.#urlUpdateCallbacks
    this.#urlUpdateCallbacks = []
    for (const callback of callbacks) {
      callback()
    }
  }

  /**
   * Update the agent URL.
   * @param {string|URL} url - New agent URL
   */
  setUrl (url) {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      log.warn('Failed to parse new agent URL %s: %s', url, error.message)
      return
    }

    const applyUrl = () => {
      try {
        // Reinitialize native state with new URL. Only commit `_url` after
        // setAgentUrl succeeds — otherwise a thrown setAgentUrl would leave
        // `_url` reflecting the new URL while the WASM state still points at
        // the old one (silent JS/WASM divergence).
        this.#nativeSpans.setAgentUrl(parsed.toString())
        this._url = parsed
      } catch (error) {
        log.warn('Failed to apply new agent URL to native state %s: %s', url, error.message)
      }
    }

    this.#urlUpdateCallbacks.push(applyUrl)
    this.#finishUrlUpdateCallbacks()
  }

  /**
   * Queue one finalized trace chunk.
   * @param {Array<object>} spans Finalized spans to export
   */
  export (spans) {
    if (this.#disabled || spans.length === 0) return

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Queueing payload: ${formatSpansForDebug(spans)}`)

    const { flushInterval } = this._config
    if (flushInterval === 0) {
      this.#encoder.encode(spans)
      this.#stageEncodedPayload()
      this.flush()
      return
    }

    this.#pendingTraces.push(spans)
    this.#pendingSpanCount += spans.length

    if (this.#pendingSpanCount >= MAX_PENDING_SPANS) {
      this.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.flush()
        this.#timer = undefined
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  /**
   * Compatibility surface for tooling that calls `_writer.flush(cb)`. Native
   * stats must flush after traces so recently prepared chunks are included.
   * @param {Function} [done] Callback when both flushes complete
   */
  #flushWithStats (done = () => {}) {
    this.flush(() => {
      this.flushStats().then(() => done(), (error) => {
        log.error('Error force-flushing native stats via _writer.flush: %s', error)
        done()
      })
    })
  }

  /**
   * Force-flush native stats after an explicit trace flush.
   * @returns {Promise<boolean>}
   */
  flushStats () {
    return this.#nativeSpans.flushStats()
  }

  #finishFlushCallbacks () {
    const callbacks = this.#flushCallbacks
    this.#flushCallbacks = []
    let firstError
    let hasError = false
    for (const done of callbacks) {
      try {
        done()
      } catch (error) {
        if (!hasError) {
          firstError = error
          hasError = true
        }
      }
    }
    if (hasError) {
      setImmediate(() => { throw firstError })
    }
  }

  #finishSend () {
    if (!this.#hasPendingWork()) {
      this.#finishFlushCallbacks()
      this.#finishUrlUpdateCallbacks()
      return
    }

    // Explicit and elapsed flushes clear the timer. Ordinary traffic keeps its
    // existing timer so a send completion does not bypass the batching window.
    if (this.#timer === undefined) this.flush()
  }

  /**
   * @param {Error & { code?: string }} error Native send error
   */
  #handleSendError (error) {
    this.#flushInFlight = false
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${error.name}`, true)
    if (error.code) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${error.code}`, true)
    }
    log.error('Error sending spans to agent via native exporter: %s', error)
    // Stop after a one-shot native exporter build failure.
    if (error?.name === 'NativeExporterBuildError') {
      this.#disabled = true
      this.#encoder.reset()
      this.#pendingPayloads = []
      this.#pendingSpanCount = 0
      this.#pendingTraces = []
      clearTimeout(this.#timer)
      this.#timer = undefined
      log.error('Native exporter disabled after a fatal build error; no further spans will be sent')
      this.#finishFlushCallbacks()
      return
    }
    // Transient failures still drain work queued during the failed send.
    this.#finishSend()
  }

  /**
   * Flush pending spans to the agent.
   *
   * @param {Function} [done] - Callback when flush completes
   */
  flush (done) {
    if (done) this.#flushCallbacks.push(done)

    if (this.#disabled) {
      this.#finishFlushCallbacks()
      return
    }
    clearTimeout(this.#timer)
    this.#timer = undefined

    // Explicit flush callbacks wait until the exporter is idle.
    if (this.#flushInFlight) {
      return
    }

    if (!this.#hasPendingWork()) {
      this.#finishFlushCallbacks()
      return
    }

    if (this.#pendingPayloads.length === 0) {
      try {
        this.#encodePendingTraces()
      } catch (error) {
        this.#handleSendError(error)
        return
      }
    }

    const payload = this.#pendingPayloads.shift()
    if (payload === undefined) {
      this.#finishFlushCallbacks()
      this.#finishUrlUpdateCallbacks()
      return
    }

    // Serialize preparation and sends because libdatadog allows only one
    // prepared-send transaction at a time.
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)
    // Publish when a send is attempted, matching the legacy AgentWriter. This
    // must also fire when the agent is unreachable.
    if (!this.#firstFlushSent && firstFlushChannel.hasSubscribers) {
      this.#firstFlushSent = true
      firstFlushChannel.publish()
    }
    let send
    try {
      send = this.#nativeSpans.sendEncodedTraces(payload)
    } catch (error) {
      this.#handleSendError(error)
      return
    }
    this.#flushInFlight = true
    send
      .then((response) => {
        this.#updateSamplingRates(response)
        this.#flushInFlight = false
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        // Flush callbacks wait until the exporter is idle so explicit flush
        // endpoints only acknowledge once all queued sends have reached the agent.
        this.#finishSend()
      }, (error) => {
        this.#handleSendError(error)
      })
  }

  /**
   * Stage the encoder's current payload for an asynchronous send.
   */
  #stageEncodedPayload () {
    if (this.#encoder.count() > 0) {
      this.#pendingPayloads.push(this.#encoder.makePayload())
    }
  }

  /**
   * Encode all finalized trace chunks in the current batch.
   */
  #encodePendingTraces () {
    const traces = this.#pendingTraces
    this.#pendingTraces = []
    this.#pendingSpanCount = 0

    try {
      for (const trace of traces) {
        this.#encoder.encode(trace)
      }
      this.#stageEncodedPayload()
    } catch (error) {
      this.#encoder.reset()
      throw error
    }
  }

  /**
   * @returns {boolean} Whether finalized or encoded trace data is waiting to be sent
   */
  #hasPendingWork () {
    return this.#pendingPayloads.length > 0 || this.#pendingTraces.length > 0
  }

  /**
   * Apply `rate_by_service` from a native response. `unchanged`, empty, and
   * malformed responses leave the current sampler state intact.
   * @param {string} response Native send response body
   */
  #updateSamplingRates (response) {
    // No body to parse: rates unchanged, or nothing was sent this cycle.
    if (!response || response === 'unchanged' || response === 'no spans to flush') {
      return
    }

    try {
      const { rate_by_service: rateByService } = JSON.parse(response)
      if (rateByService) {
        this._prioritySampler.update(rateByService)
      }
    } catch (error) {
      log.error('Error updating priority sampler rates from native response: %s', error)
    }
  }
}

module.exports = NativeExporter
