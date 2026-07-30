'use strict'

const { URL, format } = require('url')

const { channel } = require('dc-polyfill')

const defaults = require('../../config/defaults')
const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const { fetchAgentInfo } = require('../../agent/info')
const { logIntegrations, logAgentError } = require('../../startup-log')
const telemetryMetrics = require('../../telemetry/metrics')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')
const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

// Mirrors the legacy AgentWriter so operators see the same tracer-health
// metrics on the native export path. The native `sendPreparedChunk` does not
// surface the HTTP status code, so `.responses.by.status` is intentionally
// omitted (libdatadog handles the transport); requests/responses/errors are
// emitted around each send attempt.
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

// Pending spans tolerated before a flush is forced ahead of `flushInterval`.
// The legacy encoder tripped at 8 MB of encoded trace bytes; at a few hundred
// bytes per span this is the same order of magnitude, and it is far enough above
// normal traffic that the single-request path is what almost every flush takes.
const SOFT_LIMIT_SPANS = 10_000

// JS-side debug view of the spans being exported. The native pipeline
// serializes in WASM, so mirror the legacy AgentWriter's `Encoding payload`
// debug log here for observability: name/resource/service plus meta, merging
// the trace-level tags (e.g. `_dd.git.repository_url`) that the WASM exporter
// stamps onto the chunk. Only built when DD_TRACE_DEBUG is on (log.debug lazy).
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
 * NativeExporter sends spans to the Datadog agent via the native
 * `NativeSpansInterface`, which handles serialization and HTTP transport
 * in Rust. JS receives raw span objects (no pre-formatting), batches them
 * by span ID, and hands the batch to the native TraceExporter.
 */
class NativeExporter {
  #timer
  #flushInFlight = false
  // An explicit flush() arrived while a send was in flight, so the send's
  // completion must drain rather than wait for the next batching timer.
  #flushRequested = false
  #firstFlushSent = false
  #flushCallbacks = []
  #activeSpans = 0
  #urlUpdateCallbacks = []
  // Set when libdatadog reports a fatal exporter-build failure (bad config):
  // building is one-shot and won't recover, so we stop exporting rather than
  // loop on the same error every flush.
  #disabled = false
  // Non-null only on the OTLP route: the protocol tag for the export counters.
  #otlpTelemetryTags = null
  // One queued idle-reset is enough; without this every non-recording trace
  // appends another identical closure that rebuilds the whole 8 MB WASM state.
  #resetQueued = false
  // Dropped spans still resident in the WASM map, awaiting a state rebuild.
  #retainedDroppedSpans = 0
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
    this._pendingSpanChunks = []

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
    // the MaxListenersExceededWarning. Final stats must run after final traces:
    // preparing trace chunks feeds the native concentrator.
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
    // `otel.traces_export_attempts`/`_successes` are the only signal for whether a
    // customer's OTLP trace export is working. The deleted JS OTLP exporter emitted
    // them per HTTP request; OTLP logs and metrics still do, so without this the
    // traces signal alone flatlines to zero for every native-path user. Keep the
    // exact tag set it used (`protocol` + `encoding`) so the three signals remain
    // comparable and existing monitors filtering on `encoding` still match.
    const isProtobuf = config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL === 'http/protobuf'
    this.#otlpTelemetryTags = [
      // Lowercase first: the old derivation went through `new URL().protocol`.
      `protocol:${String(endpoint).toLowerCase().startsWith('https:') ? 'https' : 'http'}`,
      `encoding:${isProtobuf ? 'protobuf' : 'json'}`,
    ]

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
   * Mirror the deleted OtlpHttpTraceExporter's per-request telemetry counters.
   * No-op on the agent path.
   *
   * The deleted JS exporter's `export()` was invoked per trace chunk and issued
   * one HTTP request each, tagged with that chunk's span count.
   * `flushSpansGrouped` also sends one request per chunk, so emit once per group
   * with that group's span count: a single per-flush increment would under-count
   * attempts by the number of chunks and would turn `spans:` into an unbounded
   * whole-flush total (the telemetry namespace map never evicts keys).
   *
   * @param {string} metric `otel.traces_export_attempts` or `..._successes`
   * @param {Array<{spanIds: Uint8Array[]}>} groups Groups in this flush
   */
  #recordOtlpTelemetry (metric, groups) {
    if (this.#otlpTelemetryTags === null) return
    for (const group of groups) {
      tracerMetrics.count(metric, [...this.#otlpTelemetryTags, `spans:${group.spanIds.length}`]).inc(1)
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
        try {
          this._nativeSpans.setUseV05(true)
        } catch (e) {
          // This runs inside an HTTP response callback, so a throw would surface
          // as an uncaughtException. v0.5 is an optional upgrade: stay on v0.4.
          log.warn('Native exporter: failed to enable v0.5 output, staying on v0.4: %s', e.message)
        }
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

  /**
   * Reclaim WASM span slots held by spans that were dropped instead of exported.
   *
   * `prepareChunk` is the only call that releases a span, and it stages whatever
   * it releases, so a dropped trace cannot be released individually - rebuilding
   * the whole state is the only reclamation available. That costs a fresh 8 MB
   * change queue, so it is amortized: retain up to `SOFT_LIMIT_SPANS` dropped
   * spans (a few MB at typical span sizes) and rebuild once, rather than paying a
   * rebuild per dropped trace. Before this, a route on the documented http
   * `blocklist` rebuilt state on every filtered request.
   *
   * @param {number} [dropped] Spans just dropped, for the retention accounting
   */
  _resetNativeStateWhenIdle (dropped = 0) {
    if (this.#disabled || this.#nativeStatsEnabled()) return
    this.#retainedDroppedSpans += dropped
    if (this.#retainedDroppedSpans < SOFT_LIMIT_SPANS && dropped > 0) return
    if (this.#resetQueued) return
    this.#resetQueued = true
    this.#urlUpdateCallbacks.push(() => {
      this.#resetQueued = false
      this.#retainedDroppedSpans = 0
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
   * Export spans to the agent.
   *
   * In native mode, we receive raw span objects (not formatted) and collect
   * them for batch export. The native side handles serialization.
   *
   * @param {Array<object>} spans - Array of span objects to export
   */
  export (spans) {
    if (this.#disabled) return

    // Note: sampler-rejected traces are NOT dropped here, on either pipeline.
    // The agent needs them to compute stats, and libdatadog applies its own
    // client-side p0 drop before writing an OTLP payload, so a rejected trace
    // never reaches a collector either. Dropping them in JS would also mean
    // leaving their spans resident in the WASM map, since `prepareChunk` is the
    // only call that releases a span and it stages whatever it releases.

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Encoding payload: ${formatSpansForDebug(spans)}`)

    // Collect spans for batch export. `_pendingSpans` remains a flat buffer for
    // observability/tests; `_pendingSpanChunks` preserves each SpanProcessor
    // export call as a trace chunk. Preserving chunk boundaries matters when a
    // delayed child span from an already-exported trace finishes before the
    // HTTP timer fires: the legacy writer sends that child as a second chunk,
    // not coalesced back into the parent chunk.
    for (const span of spans) {
      this._pendingSpans.push(span)
    }
    if (spans.length > 0) this._pendingSpanChunks.push(spans)

    const { flushInterval } = this._config

    // `flushInterval === 0` is flush-per-export. The soft limit forces the same
    // decision for a different reason: it bounds how much is buffered before the
    // first send, mirroring the legacy v0.4 encoder's 8 MB soft-limit flush
    // ("Buffer went over soft limit, flushing"). Span count is the only size proxy
    // available before WASM serializes the payload. `flush()` caps the payload it
    // takes as well, which is what bounds a backlog built during an in-flight send.
    if (flushInterval === 0 || this._pendingSpans.length >= SOFT_LIMIT_SPANS) {
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
   * Compatibility shim for external tooling (e.g. the system-tests weblog and
   * parametric app) that reaches `tracer._exporter._writer.flush(cb)`; the
   * legacy AgentExporter exposed a `_writer`.
   *
   * The legacy AgentWriter.flush() shipped traces; client-computed stats were
   * flushed separately (the weblog /flush endpoint also calls
   * `_processor._stats.onInterval()`). In native mode APM stats live in the
   * WASM concentrator (not `_processor._stats`) and otherwise ship only on a
   * 10s interval, which a test-harness teardown can beat. So flush traces
   * first (at the default non-zero flushInterval, prepareChunk feeds the
   * concentrator synchronously before the send), then force-flush the native
   * stats concentrator, and signal `done` only after both — callers like the
   * /flush endpoint await this, so the async stats send completes before the
   * process is torn down. `flushStats()` is a no-op (resolves immediately) when
   * native stats are disabled, so this is inert otherwise.
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
   * Force-flush the native stats concentrator to /v0.6/stats. Trace flush runs
   * on a short interval, so stats are NOT flushed there (that would repeatedly
   * ship the current partial 10s bucket); stats have their own 10s interval.
   * This is the explicit force-flush used by the parametric test client's
   * stats-flush endpoint (call it AFTER a trace flush so the just-exported spans
   * are already in the concentrator).
   *
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
    // Only drain eagerly when something is actually waiting on this send.
    // Draining unconditionally defeated flushInterval entirely: any span that
    // finished inside a send window triggered another send the moment the
    // previous one resolved, turning a 2s batch into one request per round trip.
    const waiting = this.#flushRequested ||
      this.#flushCallbacks.length > 0 ||
      this.#urlUpdateCallbacks.length > 0
    this.#flushRequested = false

    if (this._pendingSpanChunks.length > 0 && waiting) {
      this.flush()
      return
    }

    this.#finishFlushCallbacks()
    this.#finishUrlUpdateCallbacks()

    // An explicit flush() during the send cleared the batching timer; re-arm it
    // so spans buffered in the meantime still go out on the normal interval.
    const { flushInterval } = this._config
    if (this._pendingSpanChunks.length > 0 && flushInterval > 0 && this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.flush()
        this.#timer = undefined
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  #handleSendError (err) {
    this.#flushInFlight = false
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
    runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)
    if (err.code) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
    }
    // Non-transmitting: telemetry ships through the same agent, so an
    // unreachable agent would turn every failed flush into another payload for
    // the unreachable agent. Tracer health is already on `${METRIC_PREFIX}.errors`.
    logAgentError({ status: err.status, message: err.message ?? String(err) })
    log.errorWithoutTelemetry('Error sending spans to agent via native exporter:', err)
    // A fatal exporter-build error (bad config) is one-shot and won't recover;
    // libdatadog tags it as NativeExporterBuildError. Stop exporting instead of
    // looping on the same error every flush, and drop buffered spans so they
    // don't accumulate indefinitely.
    if (err?.name === 'NativeExporterBuildError') {
      this.#disabled = true
      this._pendingSpans = []
      this._pendingSpanChunks = []
      clearTimeout(this.#timer)
      this.#timer = undefined
      // Nothing will be sent again, so stop the 10s native stats interval too:
      // otherwise it keeps calling into WASM and logging against a dead agent for
      // the life of the process, pinning the 8 MB change queue with it.
      this._nativeSpans.stopStatsFlush?.()
      log.error('Native exporter disabled after a fatal build error; no further spans will be sent')
      this.#finishFlushCallbacks()
      return
    }
    // Drain on rejection too — otherwise a single transient failure would leave
    // spans buffered indefinitely (no signal beyond the log line, and bursts of
    // low-traffic services may never flush). Flush callbacks are still released
    // once the exporter is idle; errors are logged, not propagated through the
    // callback, matching the legacy writer contract.
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

    // If a send is already in flight, callbacks must wait for that send and any
    // pending spans that drain after it. The system-tests /flush endpoint relies
    // on this to observe spans that finished while a previous payload was still
    // being sent.
    if (this.#flushInFlight) {
      this.#flushRequested = true
      return
    }

    if (this._pendingSpanChunks.length === 0) {
      this.#finishFlushCallbacks()
      return
    }

    // Each chunk becomes its own HTTP request (see flushSpansGrouped), so payload
    // size is bounded by one trace and there is nothing to split here. The
    // soft-limit trigger in `export()` still bounds how much is buffered.
    const spanChunks = this._pendingSpanChunks
    this._pendingSpans = []
    this._pendingSpanChunks = []

    // Convert each SpanProcessor export call into one or more native chunks,
    // splitting only traces that happen to share one export call. Never group
    // spans from different export calls together: those calls are already the
    // JS processor's chunk boundaries, and the legacy writer preserves them even
    // when flushInterval coalesces HTTP sends.
    const groups = this.#groupsFromSpanChunks(spanChunks, true)

    // `flushSpansGrouped` sends one request per trace chunk, so count per chunk:
    // a single per-flush increment reported 1/N of the real request volume and
    // left `.requests` on a different scale from `.errors`, which is per-attempt.
    for (let i = 0; i < groups.length; i++) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)
    }
    this.#recordOtlpTelemetry('otel.traces_export_attempts', groups)
    // Self-guarded (`integrationsAlreadyRan`), so the repeat cost is one boolean.
    // Without this the on-by-default `INTEGRATIONS LOADED` startup line never
    // printed on the native path, which is a first-line support artifact.
    logIntegrations()
    // Announce the first flush when the send is *attempted*, not when it
    // succeeds — matching the legacy AgentWriter, which publishes before sending.
    // `logAbortedIntegrations` (register.js) subscribes to this channel to emit
    // `library_entrypoint.abort.integration`; gating it on send success meant a
    // refused/unreachable agent (e.g. the guardrails harness with no agent) never
    // fired it. At this point `_pendingSpans` is non-empty (flush() returned
    // early otherwise), so a real send is happening.
    if (!this.#firstFlushSent && firstFlushChannel.hasSubscribers) {
      this.#firstFlushSent = true
      firstFlushChannel.publish()
    }
    // One request per trace chunk, sequentially, preserving the legacy writer's
    // one-trace-per-payload shape that `traces[0]` consumers rely on.
    let sendGrouped
    try {
      sendGrouped = this._nativeSpans.flushSpansGrouped(groups)
    } catch (err) {
      this.#handleSendError(err)
      return
    }
    this.#flushInFlight = true
    sendGrouped
      .then((response) => {
        this.#flushInFlight = false
        for (let i = 0; i < groups.length; i++) {
          runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
        }
        this.#recordOtlpTelemetry('otel.traces_export_successes', groups)
        // The agent's response carries per-service sampling rates. Feed them
        // back into the priority sampler so adaptive (agent-driven) sampling
        // works in native mode, matching the legacy AgentWriter behaviour.
        this.#updateSamplingRates(response)
        // Drain any spans that arrived while the send was in flight. Flush
        // callbacks wait until the exporter is idle so explicit flush endpoints
        // only acknowledge once all queued sends have reached the agent.
        this.#finishSend()
      }, (err) => {
        this.#handleSendError(err)
      })
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
