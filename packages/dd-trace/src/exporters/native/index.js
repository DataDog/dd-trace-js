'use strict'

const { URL, format } = require('url')

const { channel } = require('dc-polyfill')

const exporters = require('../../../../../ext/exporters')
const defaults = require('../../config/defaults')
const { AgentEncoder } = require('../../encode/0.4')
const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const { fetchAgentInfo } = require('../../agent/info')
const { computeIntakeUrl, INTAKE_PATH } = require('../agentless/intake')
const { MAX_ACTIVE_BUFFER_SIZE } = require('../common/limits')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')

// Native sends mirror legacy exporter request/response/error health metrics.
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

// Lazy debug representation matching the legacy payload log.
/**
 * @param {object[]} spans Finalized spans
 * @returns {string}
 */
function formatSpansForDebug (spans) {
  try {
    const payload = JSON.stringify(spans, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
    return `Queueing payload: ${payload}`
  } catch {
    // A pathological tag value (e.g. circular) must never throw out of export().
    return 'Queueing payload: [unserializable]'
  }
}

/**
 * Encodes finalized spans and delegates transport to libdatadog.
 */
class NativeExporter {
  #agentless = false
  #nativeSpans
  #bufferedBytes = 0
  #timer
  #flushInFlight = false
  #firstFlushSent = false
  #flushCallbacks = []
  #encoder
  #pendingPayloads = []
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
    this.#agentless = config.experimental?.exporter === exporters.AGENTLESS
    const nativeSpanEvents = this.#agentless ||
      config.DD_TRACE_NATIVE_SPAN_EVENTS ||
      config.OTEL_TRACES_EXPORTER === 'otlp'
    this.#encoder = new AgentEncoder({
      flush: () => {
        this.#stageEncodedPayload()
        this.flush()
      },
      onError: error => this.#handleEncodeError(error),
    }, undefined, nativeSpanEvents)
    this._writer = { flush: this.#flushWithStats.bind(this) }

    if (this.#agentless) {
      this.#configureAgentless()
    } else {
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
   * Apply agentless intake configuration before the first native send.
   */
  #configureAgentless () {
    const apiKey = this._config.DD_API_KEY
    if (!apiKey) {
      this.#disabled = true
      this._url = undefined
      log.error('DD_API_KEY is required for native agentless trace intake. Traces will not be sent.')
      return
    }

    try {
      const url = new URL(computeIntakeUrl(this._config.site))
      const endpoint = new URL(INTAKE_PATH, url).toString()
      this.#nativeSpans.setAgentlessEndpoint(endpoint, apiKey)
      this._url = url
    } catch (error) {
      this.#disabled = true
      this._url = undefined
      log.error('Failed to configure native agentless trace intake: %s', error)
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
    if (this.#disabled) return

    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      log.warn('Failed to parse new agent URL %s: %s', url, error.message)
      return
    }

    const applyUrl = () => {
      try {
        if (this.#agentless) {
          const endpoint = new URL(INTAKE_PATH, parsed).toString()
          this.#nativeSpans.setAgentlessEndpoint(endpoint, this._config.DD_API_KEY)
        } else {
          this.#nativeSpans.setAgentUrl(parsed.toString())
        }
        // Only commit `_url` after native state replacement succeeds. Otherwise
        // JS and WASM would report different active destinations.
        this._url = parsed
      } catch (error) {
        log.warn('Failed to apply new native export URL %s: %s', url, error.message)
      }
    }

    this.#urlUpdateCallbacks.push(applyUrl)
    this.#finishUrlUpdateCallbacks()
  }

  /**
   * Encode one finalized trace chunk.
   * @param {Array<object>} spans Finalized spans to export
   */
  export (spans) {
    if (this.#disabled || spans.length === 0) return

    log.debug(formatSpansForDebug, spans)

    this.#encoder.encode(spans)

    const { flushInterval } = this._config
    if (flushInterval === 0) {
      this.#stageEncodedPayload()
      this.flush()
      return
    }

    if (this.#timer === undefined && this.#encoder.count() > 0) {
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
   * @param {unknown} error Export error
   */
  #recordError (error) {
    const name = error?.name ?? 'Error'
    const code = error?.code
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${name}`, true)
    if (code) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${code}`, true)
    }
  }

  /**
   * @param {unknown} error Encoding error
   */
  #handleEncodeError (error) {
    this.#recordError(error)
    log.error('Error encoding spans for native export: %s', error)
  }

  /**
   * @param {Error & { code?: string }} error Native send error
   * @param {number} payloadBytes Size charged to the export buffer
   */
  #handleSendError (error, payloadBytes) {
    this.#bufferedBytes -= payloadBytes
    this.#flushInFlight = false
    this.#recordError(error)
    log.error('Error sending spans via native exporter: %s', error)
    // Stop after a one-shot native exporter build failure.
    if (error?.name === 'NativeExporterBuildError') {
      this.#disabled = true
      this.#encoder.reset()
      this.#pendingPayloads = []
      this.#urlUpdateCallbacks = []
      this.#bufferedBytes = 0
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
   * Flush pending spans to the configured destination.
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
        this.#stageEncodedPayload()
      } catch (error) {
        this.#encoder.reset()
        this.#handleEncodeError(error)
        this.#finishFlushCallbacks()
        this.#finishUrlUpdateCallbacks()
        return
      }
    }

    const payload = this.#pendingPayloads.shift()

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
      this.#handleSendError(error, payload.length)
      return
    }
    this.#flushInFlight = true
    send
      .then((response) => {
        this.#bufferedBytes -= payload.length
        this.#updateSamplingRates(response)
        this.#flushInFlight = false
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        // Flush callbacks wait until the exporter is idle so explicit flush
        // endpoints only acknowledge once all queued sends have reached the destination.
        this.#finishSend()
      }, (error) => {
        this.#handleSendError(error, payload.length)
      })
  }

  /**
   * Stage the encoder's current payload for an asynchronous send.
   */
  #stageEncodedPayload () {
    if (this.#encoder.count() > 0) {
      const payload = this.#encoder.makePayload()
      if (this.#bufferedBytes + payload.length > MAX_ACTIVE_BUFFER_SIZE) {
        log.debug('Maximum native export buffer size reached: payload is discarded')
        return
      }
      this.#bufferedBytes += payload.length
      this.#pendingPayloads.push(payload)
    }
  }

  /**
   * @returns {boolean} Whether encoded trace data is waiting to be sent
   */
  #hasPendingWork () {
    return this.#pendingPayloads.length > 0 || this.#encoder.count() > 0
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
