'use strict'

const { URL, format } = require('url')

const { channel } = require('dc-polyfill')

const defaults = require('../../config/defaults')
const log = require('../../log')
const processTags = require('../../process-tags')
const runtimeMetrics = require('../../runtime_metrics')
const { fetchAgentInfo } = require('../../agent/info')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')

// Mirrors the legacy AgentWriter so operators see the same tracer-health
// metrics on the native export path. The native `sendPreparedChunk` does not
// surface the HTTP status code, so `.responses.by.status` is intentionally
// omitted (libdatadog handles the transport); requests/responses/errors are
// emitted around each send attempt.
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

/**
 * NativeExporter sends spans to the Datadog agent via the native
 * `NativeSpansInterface`, which handles serialization and HTTP transport
 * in Rust. JS receives raw span objects (no pre-formatting), batches them
 * by span ID, and hands the batch to the native TraceExporter.
 */
class NativeExporter {
  #timer
  #flushInFlight = false
  #firstFlushSent = false
  // Set when libdatadog reports a fatal exporter-build failure (bad config):
  // building is one-shot and won't recover, so we stop exporting rather than
  // loop on the same error every flush.
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
    this._pendingSpans = []

    const { url, hostname = defaults.hostname, port } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname,
      port,
    }))

    // v0.5 output is opt-in via DD_TRACE_AGENT_PROTOCOL_VERSION=0.5 AND requires
    // the agent to advertise /v0.5/traces. The v0.5 wire schema has no slot for
    // meta_struct (or top-level span_events/span_links), so libdatadog silently
    // drops them in v0.5 mode — matching the legacy v0.5 encoder. It must never
    // be enabled implicitly, hence the explicit-opt-in + capability check.
    // OTLP export (OTEL_TRACES_EXPORTER=otlp) routes traces to an OTLP endpoint
    // via libdatadog instead of the Datadog agent. It is mutually exclusive with
    // the agent v0.4/v0.5 path, so it takes precedence and v0.5 is not negotiated.
    if (config.OTEL_TRACES_EXPORTER === 'otlp') {
      this.#configureOtlp()
    } else if (config.protocolVersion === '0.5') {
      this.#negotiateV05()
    }

    // Register on the dd-trace shared beforeExit handler list rather than
    // attaching directly to `process` — repeated tracer instantiation (tests,
    // hot reload, lambda re-init) would otherwise leak listeners and trip
    // the MaxListenersExceededWarning.
    const handlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
    if (handlers) {
      handlers.add(() => this.flush())
    } else {
      process.once('beforeExit', () => this.flush())
    }
  }

  /**
   * Configure libdatadog to export traces over OTLP HTTP (instead of the agent)
   * from the resolved OTEL_EXPORTER_OTLP_TRACES_* config. Synchronous, so it
   * takes effect before the first flush (the native output format is fixed at
   * first send).
   */
  #configureOtlp () {
    const config = this._config
    const endpoint = config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    if (!endpoint) {
      // OTEL_TRACES_EXPORTER=otlp but no endpoint resolved (normally config
      // defaults this). Without an endpoint there's nothing to route to, so
      // leave the exporter on the agent path rather than passing undefined.
      log.warn('Native exporter: OTEL_TRACES_EXPORTER=otlp but no OTLP traces endpoint resolved; skipping OTLP setup')
      return
    }
    // A malformed endpoint is intentionally NOT caught here (unlike protocol
    // below): it fails loud at build/first-send rather than silently degrading,
    // since there is no sensible default endpoint to fall back to.
    this._nativeSpans.setOtlpEndpoint(endpoint)

    const protocol = config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    if (protocol) {
      try {
        this._nativeSpans.setOtlpProtocol(protocol)
      } catch (e) {
        // grpc / unknown: libdatadog only supports http/json and http/protobuf.
        // Fall back to the native default rather than failing tracer startup.
        log.warn('Native exporter: unsupported OTLP protocol %s, using default: %s', protocol, e.message)
      }
    }

    // OTEL_EXPORTER_OTLP_TRACES_HEADERS is a parsed { key: value } map; flatten
    // to the [key, value, ...] array the native binding expects.
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
   * Confirm the agent supports v0.5 before switching the native exporter to it.
   * Asynchronous: until /info resolves the exporter stays on v0.4 (the safe
   * default), so an early first flush may go out as v0.4 — acceptable, since
   * v0.4 loses no data. The native output format is fixed at the first send,
   * so this must resolve before then (it normally does: /info is fast and the
   * first flush is on a timer).
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

  /**
   * Export spans to the agent.
   *
   * In native mode, we receive raw span objects (not formatted) and collect
   * them for batch export. The native side handles serialization.
   *
   * @param {Array<object>} spans - Array of span objects to export
   */
  export (spans) {
    if (this.#disabled) return
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
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  /**
   * Flush pending spans to the agent.
   *
   * @param {Function} [done] - Callback when flush completes
   */
  flush (done = () => {}) {
    if (this.#disabled) {
      done()
      return
    }
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

    // Add trace-level tags to the first span in the chunk so the WASM
    // pipeline emits them on the local-root span.
    if (firstIsLocalRoot && spans.length > 0) {
      this.#syncTraceTags(spans[0])
    }

    // Collect span ids for native export (the op/flush handle is the span_id).
    // Note: flushChangeQueue is called inside flushSpans, no need to call it here
    const spanIds = spans.map(span => span.context()._nativeSpanId)

    // prepareChunk is synchronous — extract spans from native storage now.
    // sendPreparedChunk is async (HTTP send). We serialize sends so that
    // prepared chunks don't accumulate faster than they can be sent, which
    // would cause unbounded memory growth proportional to total requests.
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)
    this._nativeSpans.flushSpans(spanIds, firstIsLocalRoot)
      .then((response) => {
        this.#flushInFlight = false
        runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        // The agent's response carries per-service sampling rates. Feed them
        // back into the priority sampler so adaptive (agent-driven) sampling
        // works in native mode, matching the legacy AgentWriter behaviour.
        this.#updateSamplingRates(response)
        if (!this.#firstFlushSent) {
          this.#firstFlushSent = true
          firstFlushChannel.publish()
        }
        // Drain any spans that arrived while the send was in flight.
        if (this._pendingSpans.length > 0) {
          this.flush()
        }
      }, (err) => {
        this.#flushInFlight = false
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
        runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)
        if (err.code) {
          runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
        log.error('Error sending spans to agent via native exporter:', err)
        // A fatal exporter-build error (bad config) is one-shot and won't
        // recover; libdatadog tags it as NativeExporterBuildError. Stop
        // exporting instead of looping on the same error every flush, and drop
        // buffered spans so they don't accumulate indefinitely.
        if (err?.name === 'NativeExporterBuildError') {
          this.#disabled = true
          this._pendingSpans = []
          clearTimeout(this.#timer)
          this.#timer = undefined
          log.error('Native exporter disabled after a fatal build error; no further spans will be sent')
          return
        }
        // Drain on rejection too — otherwise a single transient failure
        // would leave spans buffered indefinitely (no signal beyond the
        // log line, and bursts of low-traffic services may never flush).
        if (this._pendingSpans.length > 0) {
          this.flush()
        }
      })
    this.#flushInFlight = true
    done()
  }

  /**
   * Feed agent-reported sampling rates back into the priority sampler.
   *
   * The native `sendPreparedChunk` resolves with the agent's response body:
   * `'unchanged'` when the rates have not changed since the last flush (the
   * agent negotiates this via the rates payload-version header), otherwise the
   * raw JSON body containing `rate_by_service`. Parse the latter and forward
   * the rate map to the priority sampler. Errors are swallowed (logged) so a
   * malformed response never disrupts the flush cycle.
   *
   * @param {string} response - Resolved value from `flushSpans`
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

    // Add each trace tag to the span's tags
    // This uses the span's tag proxy which syncs to native storage
    for (const [key, value] of Object.entries(traceTags)) {
      if (value !== undefined && value !== null && // Don't overwrite existing span tags
        !context.hasTag(key)) {
        context.setTag(key, value)
      }
    }

    if (this._config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED &&
      processTags.serialized && !context.hasTag(processTags.TRACING_FIELD_NAME)) {
      context.setTag(processTags.TRACING_FIELD_NAME, processTags.serialized)
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
