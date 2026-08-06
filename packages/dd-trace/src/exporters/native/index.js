'use strict'

const { URL, format } = require('node:url')

const { channel } = require('dc-polyfill')

const { fetchAgentInfo } = require('../../agent/info')
const defaults = require('../../config/defaults')
const log = require('../../log')
const runtimeMetrics = require('../../runtime_metrics')
const { logAgentError, logIntegrations } = require('../../startup-log')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')
const MAX_PENDING_SPANS = 2000
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

function formatSpansForDebug (spans) {
  try {
    const formatted = new Array(spans.length)
    for (let i = 0; i < spans.length; i++) {
      const context = spans[i].context()
      formatted[i] = {
        name: context._name,
        resource: context.getTag('resource.name'),
        service: context.getTag('service.name'),
        meta: { ...context._trace?.tags, ...context.getTags() },
      }
    }
    return JSON.stringify(formatted, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  } catch {
    return '[unserializable]'
  }
}

/** Batches native trace groups and delegates transport to libdatadog. */
class NativeExporter {
  #activeSpans = 0
  #disabled = false
  #firstFlushSent = false
  #flushCallbacks = []
  #pendingSpanChunks = []
  #pendingSpanCount = 0
  #sendGroups = []
  #sendGroupIndex = 0
  #sendInFlight = false
  #timer
  #urlUpdateCallbacks = []

  /**
   * @param {object} config Tracer configuration
   * @param {object} prioritySampler Priority sampler
   * @param {import('../../native/native_spans')} nativeSpans Native span storage
   */
  constructor (config, prioritySampler, nativeSpans) {
    this._config = config
    this._prioritySampler = prioritySampler
    this._nativeSpans = nativeSpans

    const { url, hostname = defaults.hostname, port } = config
    this._url = url || new URL(format({ protocol: 'http:', hostname, port }))
    this._writer = { flush: done => this.flush(done) }

    if (config.OTEL_TRACES_EXPORTER === 'otlp') {
      this.#configureOtlp()
    } else if (config.protocolVersion === '0.5') {
      this.#negotiateV05()
    }

    const finalFlush = () => this.flush()
    const handlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
    if (handlers) {
      handlers.add(finalFlush)
    } else {
      process.once('beforeExit', finalFlush)
    }
  }

  /** Apply resolved OTLP configuration before the first send. */
  #configureOtlp () {
    const endpoint = this._config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    if (!endpoint) {
      log.warn('Native exporter: OTEL_TRACES_EXPORTER=otlp but no OTLP traces endpoint is configured')
      return
    }
    this._nativeSpans.setOtlpEndpoint(endpoint)

    const protocol = this._config.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
    if (protocol) {
      try {
        this._nativeSpans.setOtlpProtocol(protocol)
      } catch (error) {
        log.warn('Native exporter: unsupported OTLP protocol %s, using default: %s', protocol, error.message)
      }
    }

    const headers = this._config.OTEL_EXPORTER_OTLP_TRACES_HEADERS
    if (!headers || typeof headers !== 'object') return
    const flat = []
    for (const key of Object.keys(headers)) flat.push(key, String(headers[key]))
    if (flat.length > 0) this._nativeSpans.setOtlpHeaders(flat)
  }

  /** Enable v0.5 only after the agent advertises support. */
  #negotiateV05 () {
    fetchAgentInfo(this._url, (error, info) => {
      if (error) {
        log.debug('Native exporter: /info fetch failed, staying on v0.4: %s', error.message)
        return
      }
      if (Array.isArray(info?.endpoints) && info.endpoints.includes('/v0.5/traces')) {
        this._nativeSpans.setUseV05(true)
      }
    })
  }

  /** Record a native span whose state must survive URL changes. */
  _trackSpanStart () {
    this.#activeSpans++
  }

  /** Release one active-span reference and apply deferred URL changes when idle. */
  _trackSpanFinish () {
    if (this.#activeSpans > 0) this.#activeSpans--
    this.#finishUrlUpdates()
  }

  /**
   * Remove spans that the processor filtered after native allocation.
   * @param {object[]} spans Native spans to discard
   * @returns {boolean} Whether native state removed at least one group
   */
  _discardNativeSpans (spans) {
    if (!spans?.length) return false
    const groups = this.#groupsFromSpans(spans, false)
    if (groups.length === 0) return false
    return this._nativeSpans.discardSpansGrouped(groups) > 0
  }

  /** Rebuild native storage only after every live reference has drained. */
  _resetNativeStateWhenIdle () {
    if (this.#disabled) return
    this.#urlUpdateCallbacks.push(() => {
      try {
        this._nativeSpans.setAgentUrl(this._url.toString())
      } catch (error) {
        log.warn('Failed to reset idle native span state: %s', error.message)
      }
    })
    this.#finishUrlUpdates()
  }

  /**
   * Apply a new agent URL after active spans and queued sends have drained.
   * @param {string|URL} url New agent URL
   */
  setUrl (url) {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      log.warn('Failed to parse new agent URL %s: %s', url, error.message)
      return
    }

    this.#urlUpdateCallbacks.push(() => {
      try {
        this._nativeSpans.setAgentUrl(parsed.toString())
        this._url = parsed
      } catch (error) {
        log.warn('Failed to apply new agent URL to native state %s: %s', url, error.message)
      }
    })
    this.#finishUrlUpdates()
  }

  /**
   * Buffer one processor export call as one trace chunk.
   * @param {object[]} spans Finished native spans
   */
  export (spans) {
    if (spans.length === 0) return
    if (this.#disabled) {
      this._nativeSpans.discardSpansGrouped(this.#groupsFromSpans(spans, false))
      return
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Encoding payload: ${formatSpansForDebug(spans)}`)

    this.#pendingSpanChunks.push(spans)
    this.#pendingSpanCount += spans.length

    const { flushInterval } = this._config
    if (flushInterval === 0 || this.#pendingSpanCount >= MAX_PENDING_SPANS) {
      this.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.flush(), flushInterval)
      this.#timer.unref?.()
    }
  }

  /**
   * Flush all groups currently buffered by the exporter.
   * @param {Function} [done] Called after the exporter becomes idle
   */
  flush (done) {
    if (done) this.#flushCallbacks.push(done)
    clearTimeout(this.#timer)
    this.#timer = undefined

    if (this.#disabled) {
      this.#finishFlushCallbacks()
      return
    }

    this.#queuePendingGroups()
    if (!this.#sendInFlight) this.#sendNextBatch()
  }

  /** Move pending trace chunks into the serialized send queue. */
  #queuePendingGroups () {
    if (this.#pendingSpanChunks.length === 0) return
    if (this.#sendGroupIndex === this.#sendGroups.length) {
      this.#sendGroups = []
      this.#sendGroupIndex = 0
    }
    const pendingSpanChunks = this.#pendingSpanChunks
    this.#pendingSpanChunks = []
    for (const spans of pendingSpanChunks) {
      const groups = this.#groupsFromSpans(spans, true)
      for (const group of groups) this.#sendGroups.push(group)
    }
    this.#pendingSpanCount = 0
  }

  /** Send the next request, or finish the current flush. */
  #sendNextBatch () {
    if (this.#sendGroupIndex >= this.#sendGroups.length) {
      this.#finishSendQueue()
      return
    }

    let batch
    if (this._config.flushInterval === 0) {
      batch = [this.#sendGroups[this.#sendGroupIndex++]]
    } else {
      batch = this.#sendGroups
      this.#sendGroupIndex = this.#sendGroups.length
    }

    this.#sendInFlight = true
    runtimeMetrics.increment(`${METRIC_PREFIX}.requests`, true)
    if (!this.#firstFlushSent) {
      this.#firstFlushSent = true
      if (firstFlushChannel.hasSubscribers) firstFlushChannel.publish()
    }

    this._nativeSpans.flushSpansGrouped(batch, (error, response) => {
      this.#sendInFlight = false
      this.#recordResponse(error, response)
      if (this.#disabled) {
        this.#discardQueuedGroups()
        this.#finishSendQueue()
        return
      }
      this.#sendNextBatch()
    })
  }

  /**
   * Mirror legacy exporter health, startup, and sampling side effects.
   * @param {Error|undefined} error Send failure
   * @param {string|undefined} response Agent response body
   */
  #recordResponse (error, response) {
    logIntegrations()
    if (error) {
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors`, true)
      runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${error.name}`, true)
      if (error.code) runtimeMetrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${error.code}`, true)
      logAgentError({ status: error.status, message: error.message })
      log.errorWithoutTelemetry('Error sending spans to agent via native exporter:', error)
      if (error.name === 'NativeExporterBuildError') {
        this.#disabled = true
        log.error('Native exporter disabled after a fatal build error')
      }
      return
    }

    runtimeMetrics.increment(`${METRIC_PREFIX}.responses`, true)
    if (!response || response === 'unchanged' || response === 'no spans to flush') return
    try {
      const { rate_by_service: rateByService } = JSON.parse(response)
      if (rateByService) this._prioritySampler.update(rateByService)
    } catch (parseError) {
      log.error('Error updating priority sampler rates from native response:', parseError)
    }
  }

  /** Drop every group that has not yet been extracted from native storage. */
  #discardQueuedGroups () {
    if (this.#sendGroupIndex < this.#sendGroups.length) {
      this._nativeSpans.discardSpansGrouped(this.#sendGroups.slice(this.#sendGroupIndex))
    }
    for (const spans of this.#pendingSpanChunks) {
      this._nativeSpans.discardSpansGrouped(this.#groupsFromSpans(spans, false))
    }
    this.#sendGroupIndex = this.#sendGroups.length
    this.#pendingSpanChunks = []
    this.#pendingSpanCount = 0
  }

  /** Finish a drained queue and any explicit flush callbacks. */
  #finishSendQueue () {
    this.#sendGroups = []
    this.#sendGroupIndex = 0
    if (this.#pendingSpanChunks.length > 0 && this.#timer === undefined && !this.#disabled) {
      this.#queuePendingGroups()
      this.#sendNextBatch()
      return
    }
    this.#finishFlushCallbacks()
    this.#finishUrlUpdates()
  }

  /** Invoke explicit flush callbacks without letting one callback block another. */
  #finishFlushCallbacks () {
    if (this.#sendInFlight || this.#sendGroupIndex < this.#sendGroups.length) return
    const callbacks = this.#flushCallbacks
    this.#flushCallbacks = []
    let firstError
    for (const done of callbacks) {
      try {
        done()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) setImmediate(() => { throw firstError })
  }

  /** Apply deferred URL changes when no span can reference the current state. */
  #finishUrlUpdates () {
    if (this.#urlUpdateCallbacks.length === 0 || this.#activeSpans > 0 || this.#sendInFlight) return
    if (this.#pendingSpanChunks.length > 0 || this.#sendGroupIndex < this.#sendGroups.length) {
      this.flush()
      return
    }

    const callbacks = this.#urlUpdateCallbacks
    this.#urlUpdateCallbacks = []
    let firstError
    for (const callback of callbacks) {
      try {
        callback()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) setImmediate(() => { throw firstError })
  }

  /**
   * Convert spans to trace groups while preserving local-root provenance.
   * @param {object[]} spans Spans from one processor export
   * @param {boolean} syncTraceTags Whether to mirror trace tags to the chunk head
   * @returns {Array<{spanIds: Uint8Array[], firstIsLocalRoot: boolean}>}
   */
  #groupsFromSpans (spans, syncTraceTags) {
    const byTrace = new Map()
    for (const span of spans) {
      const trace = span.context()._trace
      let group = byTrace.get(trace)
      if (group === undefined) {
        group = []
        byTrace.set(trace, group)
      }
      group.push(span)
    }

    const groups = []
    for (const spansInTrace of byTrace.values()) {
      let rootIndex = -1
      for (let i = 0; i < spansInTrace.length; i++) {
        if (this.#isLocalRoot(spansInTrace[i])) {
          rootIndex = i
          break
        }
      }
      if (rootIndex > 0) {
        const root = spansInTrace[rootIndex]
        spansInTrace[rootIndex] = spansInTrace[0]
        spansInTrace[0] = root
      }
      if (syncTraceTags) this.#syncTraceTags(spansInTrace[0])

      const spanIds = new Array(spansInTrace.length)
      for (let i = 0; i < spansInTrace.length; i++) {
        spanIds[i] = spansInTrace[i].context()._nativeSpanId
      }
      groups.push({ spanIds, firstIsLocalRoot: rootIndex !== -1 })
    }
    return groups
  }

  /**
   * Mirror trace tags to the first span of every chunk.
   * @param {object} span Chunk head
   */
  #syncTraceTags (span) {
    const context = span.context()
    const traceTags = context._trace?.tags
    if (!traceTags) return

    for (const key of Object.keys(traceTags)) {
      const value = traceTags[key]
      if (value !== undefined && value !== null && !context.hasTag(key)) context.setTag(key, value)
    }
  }

  /**
   * Identify a local root, including a span whose parent was extracted remotely.
   * @param {object} span Candidate span
   * @returns {boolean}
   */
  #isLocalRoot (span) {
    const context = span.context()
    if (!context._parentId || context._isRemote) return true
    return context._trace?.started?.[0] === span
  }
}

module.exports = NativeExporter
