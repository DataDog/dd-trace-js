'use strict'

const { URL, format } = require('url')

const { channel } = require('dc-polyfill')

const defaults = require('../../config/defaults')
const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const { fetchAgentInfo } = require('../../agent/info')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')
// The JS encoder flushes at 8 MiB; libdatadog exposes no pre-serialization byte
// count. Bound the full span objects retained during the batching window instead.
const MAX_PENDING_SPANS = 2000

// Native sends mirror legacy exporter request/response/error health metrics.
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

// Lazy debug representation matching the legacy payload log.
function formatSpansForDebug (spans) {
  try {
    return JSON.stringify(
      spans.map(span => {
        const ctx = span.context()
        return {
          name: ctx._name,
          resource: ctx.getTag('resource.name'),
          service: ctx.getTag('service.name'),
          meta: { ...ctx._trace?.tags, ...ctx.getTags() },
        }
      }),
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
    )
  } catch {
    // A pathological tag value (e.g. circular) must never throw out of export().
    return '[unserializable]'
  }
}

/**
 * Batches raw spans and delegates serialization and transport to libdatadog.
 */
class NativeExporter {
  #timer
  #flushInFlight = false
  #firstFlushSent = false
  #flushCallbacks = []
  #activeSpans = 0
  #pendingSpanCount = 0
  #urlUpdateCallbacks = []
  // Fatal native exporter construction errors cannot recover.
  #disabled = false
  /**
   * @param {object} config - Tracer configuration
   * @param {object} prioritySampler - Priority sampler instance
   * @param {import('../../native/native_spans')} nativeSpans - NativeSpansInterface instance
   */
  constructor (config, prioritySampler, nativeSpans) {
    this._config = config
    this._prioritySampler = prioritySampler
    this._nativeSpans = nativeSpans
    this._pendingSpanChunks = []

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
        this.flushStats().catch((err) => {
          log.warn('Failed final native stats flush on exit:', err)
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
    this._nativeSpans.setOtlpEndpoint(endpoint)

    const protocol = config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    if (protocol) {
      try {
        this._nativeSpans.setOtlpProtocol(protocol)
      } catch (e) {
        // Unsupported protocols fall back to the native default.
        log.warn('Native exporter: unsupported OTLP protocol %s, using default: %s', protocol, e.message)
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
        this._nativeSpans.setOtlpHeaders(flat)
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
    } catch (e) {
      log.warn('Native exporter: cannot parse agent URL for /info v0.5 check: %s', e.message)
      return
    }
    fetchAgentInfo(infoUrl, (err, info) => {
      if (err) {
        log.debug('Native exporter: /info fetch failed, staying on v0.4: %s', err.message)
        return
      }
      // `endpoints` is untrusted agent input: guard the type so a malformed
      // response (non-array, or a string that substring-matches) can't throw
      // in this async callback or false-positive into v0.5.
      if (Array.isArray(info?.endpoints) && info.endpoints.includes('/v0.5/traces')) {
        this._nativeSpans.setUseV05(true)
      }
    })
  }

  _trackSpanStart () {
    this.#activeSpans++
  }

  _trackSpanFinish () {
    if (this.#activeSpans > 0) this.#activeSpans--
    this.#finishUrlUpdateCallbacks()
  }

  #nativeStatsEnabled () {
    return this._config.stats?.DD_TRACE_STATS_COMPUTATION_ENABLED === true &&
      !this._config.OTEL_TRACES_SPAN_METRICS_ENABLED
  }

  _discardNativeSpans (spans) {
    if (this.#disabled || this.#nativeStatsEnabled() || !spans?.length) return false
    const discard = this._nativeSpans.discardSpansGrouped
    if (typeof discard !== 'function') return false

    const groups = this.#groupsFromSpanChunks([spans], false)
    if (groups.length === 0) return false
    return discard.call(this._nativeSpans, groups) > 0
  }

  _resetNativeStateWhenIdle () {
    if (this.#disabled || this.#nativeStatsEnabled()) return
    this.#urlUpdateCallbacks.push(() => {
      try {
        this._nativeSpans.setAgentUrl(this._url.toString())
      } catch (e) {
        log.warn('Failed to reset idle native span state: %s', e.message)
      }
    })
    this.#finishUrlUpdateCallbacks()
  }

  #finishUrlUpdateCallbacks () {
    if (this.#urlUpdateCallbacks.length === 0) return
    if (this.#activeSpans > 0 || this.#flushInFlight) return
    if (this._pendingSpanChunks.length > 0) {
      this.flush()
      return
    }

    const callbacks = this.#urlUpdateCallbacks
    this.#urlUpdateCallbacks = []
    let firstError
    let hasError = false
    for (const callback of callbacks) {
      try {
        callback()
      } catch (err) {
        if (!hasError) {
          firstError = err
          hasError = true
        }
      }
    }
    if (hasError) {
      setImmediate(() => { throw firstError })
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
    } catch (e) {
      log.warn('Failed to parse new agent URL %s: %s', url, e.message)
      return
    }

    const applyUrl = () => {
      try {
        // Reinitialize native state with new URL. Only commit `_url` after
        // setAgentUrl succeeds — otherwise a thrown setAgentUrl would leave
        // `_url` reflecting the new URL while the WASM state still points at
        // the old one (silent JS/WASM divergence).
        this._nativeSpans.setAgentUrl(parsed.toString())
        this._url = parsed
      } catch (e) {
        log.warn('Failed to apply new agent URL to native state %s: %s', url, e.message)
      }
    }

    this.#urlUpdateCallbacks.push(applyUrl)
    this.#finishUrlUpdateCallbacks()
  }

  /**
   * Buffer one processor export call as one trace chunk.
   * @param {Array<object>} spans Spans to export
   */
  export (spans) {
    if (this.#disabled) return

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Encoding payload: ${formatSpansForDebug(spans)}`)

    // Preserve each SpanProcessor export call as a trace chunk. A delayed child
    // that finishes later must remain a second chunk rather than being merged
    // back into its parent's earlier export call.
    if (spans.length > 0) {
      this._pendingSpanChunks.push(spans)
      this.#pendingSpanCount += spans.length
    }

    const { flushInterval } = this._config

    if (flushInterval === 0 || this.#pendingSpanCount >= MAX_PENDING_SPANS) {
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
   */
  get _writer () {
    return {
      flush: (done = () => {}) => {
        this.flush(() => {
          this.flushStats().then(() => done(), (err) => {
            log.error('Error force-flushing native stats via _writer.flush:', err)
            done()
          })
        })
      },
    }
  }

  /**
   * Force-flush native stats after an explicit trace flush.
   * @returns {Promise<boolean>}
   */
  flushStats () {
    return this._nativeSpans.flushStats()
  }

  #finishFlushCallbacks () {
    const callbacks = this.#flushCallbacks
    this.#flushCallbacks = []
    let firstError
    let hasError = false
    for (const done of callbacks) {
      try {
        done()
      } catch (err) {
        if (!hasError) {
          firstError = err
          hasError = true
        }
      }
    }
    if (hasError) {
      setImmediate(() => { throw firstError })
    }
  }

  #finishSend () {
    if (this._pendingSpanChunks.length === 0) {
      this.#finishFlushCallbacks()
      this.#finishUrlUpdateCallbacks()
      return
    }

    // Explicit and elapsed flushes clear the timer. Ordinary traffic keeps its
    // existing timer so a send completion does not bypass the batching window.
    if (this.#timer === undefined) this.flush()
  }

  #handleSendError (err) {
    this.#flushInFlight = false
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)
    if (err.code) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
    }
    log.error('Error sending spans to agent via native exporter:', err)
    // Stop after a one-shot native exporter build failure.
    if (err?.name === 'NativeExporterBuildError') {
      this.#disabled = true
      this._pendingSpanChunks = []
      this.#pendingSpanCount = 0
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

    if (this._pendingSpanChunks.length === 0) {
      this.#finishFlushCallbacks()
      return
    }

    const spanChunks = this._pendingSpanChunks
    this._pendingSpanChunks = []
    this.#pendingSpanCount = 0

    // Preserve processor export-call boundaries while splitting mixed traces.
    const groups = this.#groupsFromSpanChunks(spanChunks, true)

    // Serialize asynchronous sends so prepared chunks cannot accumulate.
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)
    // Publish when a send is attempted, matching the legacy AgentWriter. This
    // must also fire when the agent is unreachable.
    if (!this.#firstFlushSent && firstFlushChannel.hasSubscribers) {
      this.#firstFlushSent = true
      firstFlushChannel.publish()
    }
    // At flushInterval 0, preserve the legacy one-trace-per-request behavior.
    // Apply sampling rates from every response, not only the last one.
    const applyResponse = (response) => {
      this.#updateSamplingRates(response)
      return response
    }
    let sendGrouped
    try {
      sendGrouped = this._config.flushInterval === 0 && groups.length > 1
        ? groups.reduce(
          (previous, group) => previous
            .then(() => this._nativeSpans.flushSpansGrouped([group]))
            .then(applyResponse),
          Promise.resolve('no spans to flush')
        )
        : this._nativeSpans.flushSpansGrouped(groups).then(applyResponse)
    } catch (err) {
      this.#handleSendError(err)
      return
    }
    this.#flushInFlight = true
    sendGrouped
      .then((response) => {
        this.#flushInFlight = false
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        // Flush callbacks wait until the exporter is idle so explicit flush
        // endpoints only acknowledge once all queued sends have reached the agent.
        this.#finishSend()
      }, (err) => {
        this.#handleSendError(err)
      })
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
    } catch (err) {
      log.error('Error updating priority sampler rates from native response:', err)
    }
  }

  #groupsFromSpanChunks (spanChunks, syncTraceTags) {
    const groups = []
    for (const spans of spanChunks) {
      const byTrace = new Map()
      for (const span of spans) {
        const trace = span.context()._trace
        let group = byTrace.get(trace)
        if (group === undefined) { group = []; byTrace.set(trace, group) }
        group.push(span)
      }

      for (const group of byTrace.values()) {
        // The local root leads the chunk so the pipeline treats it as chunk root.
        const root = group.find(span => this.#isLocalRoot(span))
        const firstIsLocalRoot = root !== undefined
        let ordered = group
        if (firstIsLocalRoot) {
          if (syncTraceTags) this.#syncTraceTags(root)
          if (group[0] !== root) {
            ordered = [root, ...group.filter(span => span !== root)]
          }
        }
        groups.push({
          spanIds: ordered.map(span => span.context()._nativeSpanId),
          firstIsLocalRoot,
        })
      }
    }
    return groups
  }

  /**
   * Sync trace-level tags to a span.
   * Trace tags are stored on the trace object and should be added to the
   * first span in each trace chunk before native export.
   *
   * @param {object} span - The first span in the chunk
   */
  #syncTraceTags (span) {
    const context = span.context()
    const traceTags = context._trace?.tags

    if (!traceTags) return

    // Keep the JS tag cache aligned with legacy writer debug/observer paths;
    // native trace tags are mirrored by SpanProcessor before export.
    for (const [key, value] of Object.entries(traceTags)) {
      if (value !== undefined && value !== null && // Don't overwrite existing span tags
        !context.hasTag(key)) {
        context.setTag(key, value)
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
   * @param {object} span - Span to check
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
