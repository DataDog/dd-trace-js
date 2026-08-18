'use strict'

const log = require('../log')
const runtimeMetrics = require('../runtime_metrics')
const { WasmSpanState } = require('./index')

const COLLAPSED_SPANS_HEALTH_METRIC = 'datadog.tracer.stats.collapsed_spans'
const COLLAPSED_SPANS_WHOLE_KEY_TAG = 'collapsed_spans:whole_key'

// The encoded pipeline does not use change-buffer storage. WasmSpanState still
// requires buffers for compatibility with its original constructor.
const CHANGE_QUEUE_BUFFER_SIZE = 8
const STRING_TABLE_INPUT_BUFFER_SIZE = 0

/**
 * Convert the legacy `unix://./pipe/...` Windows-pipe form to libdatadog's
 * `windows:` scheme. Unix sockets and HTTP URLs pass through unchanged.
 * @param {string} url Agent URL
 * @returns {string} URL accepted by libdatadog
 */
function normalizeAgentUrl (url) {
  if (typeof url === 'string' && url.startsWith('unix://./')) {
    return 'windows:' + url.slice('unix:'.length)
  }
  return url
}

/**
 * @param {unknown} result Native stats flush result
 * @returns {boolean} Whether a stats payload was sent
 */
function normalizeStatsFlushResult (result) {
  if (result == null || typeof result !== 'object') return result === true

  const collapsedSpans = result.collapsedSpans
  if (typeof collapsedSpans === 'number' && collapsedSpans > 0) {
    runtimeMetrics.count(COLLAPSED_SPANS_HEALTH_METRIC, collapsedSpans, COLLAPSED_SPANS_WHOLE_KEY_TAG, true)
  }

  return result.sent === true
}

/**
 * Configures libdatadog and transfers finalized trace payloads to WASM.
 */
class NativeSpansInterface {
  #agentUrl
  #agentlessApiKey
  #agentlessEndpoint
  #operations = new Map()
  #options
  #otlpEndpoint
  #otlpHeaders
  #otlpProtocol
  #retiredStates = new Set()
  #state
  #statsInterval
  #useV05 = false

  /**
   * @param {object} options Configuration options
   * @param {string} options.agentUrl URL of the Datadog agent
   * @param {string} options.tracerVersion Version of dd-trace
   * @param {string} [options.lang] Language identifier
   * @param {string} [options.langVersion] Language version
   * @param {string} [options.langInterpreter] Language interpreter
   * @param {number} [options.pid] Process ID
   * @param {string} options.tracerService Default service name
   * @param {boolean} [options.statsEnabled] Enable native stats collection
   * @param {string} [options.hostname] Hostname for stats payloads
   * @param {string} [options.env] Environment for stats payloads
   * @param {string} [options.appVersion] Application version for stats payloads
   * @param {string} [options.runtimeId] Runtime ID for stats payloads
   * @param {boolean} [options.clientComputedStats] Advertise client-computed stats
   */
  constructor (options) {
    if (!WasmSpanState) {
      throw new Error('Native spans module is not available')
    }

    this.#options = {
      tracerVersion: options.tracerVersion,
      lang: options.lang || 'nodejs',
      langVersion: options.langVersion || process.version,
      langInterpreter: options.langInterpreter || 'v8',
      pid: options.pid ?? process.pid,
      tracerService: options.tracerService,
      statsEnabled: options.statsEnabled || false,
      hostname: options.hostname || '',
      env: options.env || '',
      appVersion: options.appVersion || '',
      runtimeId: options.runtimeId || '',
      clientComputedStats: options.clientComputedStats || false,
    }
    this.#agentUrl = options.agentUrl
    this.#state = this.#createWasmState(this.#agentUrl)

    if (typeof this.#state.sendEncodedTraces !== 'function') {
      this.#state.free()
      throw new Error('@datadog/libdatadog pipeline is missing sendEncodedTraces; install may be outdated')
    }

    if (this.#options.statsEnabled) {
      this.#statsInterval = setInterval(() => {
        this.#flushStats(false).catch((error) => {
          log.error('Error flushing native stats: %s', error)
        })
      }, 10_000)
      this.#statsInterval.unref?.()
    }

    log.debug('Native spans interface initialized')
  }

  /**
   * Keep a native state alive until one of its asynchronous operations settles.
   * @param {object} state Native state used by the operation
   * @param {Promise<unknown>} operation Native operation
   * @returns {Promise<unknown>} The tracked operation
   */
  #trackOperation (state, operation) {
    this.#operations.set(state, (this.#operations.get(state) ?? 0) + 1)
    const settled = () => {
      const remaining = this.#operations.get(state) - 1
      if (remaining === 0) {
        this.#operations.delete(state)
        if (this.#retiredStates.delete(state)) state.free()
      } else {
        this.#operations.set(state, remaining)
      }
    }
    operation.then(settled, settled)
    return operation
  }

  /**
   * Free a superseded state after its asynchronous work completes.
   * @param {object} state Superseded native state
   */
  #releaseState (state) {
    if (this.#operations.has(state)) {
      this.#retiredStates.add(state)
    } else {
      state.free()
    }
  }

  /**
   * Construct and configure a native state through the binding's positional API.
   * @param {string} url Agent URL
   * @returns {WasmSpanState} Configured native state
   */
  #createWasmState (url) {
    const options = this.#options
    const state = new WasmSpanState(
      normalizeAgentUrl(url),
      options.tracerVersion,
      options.lang,
      options.langVersion,
      options.langInterpreter,
      CHANGE_QUEUE_BUFFER_SIZE,
      STRING_TABLE_INPUT_BUFFER_SIZE,
      options.pid,
      options.tracerService,
      options.statsEnabled,
      options.hostname,
      options.env,
      options.appVersion,
      options.runtimeId,
      options.clientComputedStats,
    )

    try {
      if (this.#useV05) state.setUseV05(true)
      if (this.#agentlessEndpoint !== undefined) {
        state.setAgentlessEndpoint(this.#agentlessEndpoint, this.#agentlessApiKey)
      }
      if (this.#otlpEndpoint !== undefined) {
        state.setOtlpEndpoint(this.#otlpEndpoint)
        if (this.#otlpProtocol !== undefined) state.setOtlpProtocol(this.#otlpProtocol)
        if (this.#otlpHeaders !== undefined) state.setOtlpHeaders(this.#otlpHeaders)
      }
      return state
    } catch (error) {
      state.free()
      throw error
    }
  }

  /**
   * Select v0.5 before the first send after agent capability negotiation.
   * @param {boolean} useV05 Whether to use v0.5
   */
  setUseV05 (useV05) {
    this.#state.setUseV05(useV05)
    this.#useV05 = useV05
  }

  /**
   * Select agentless trace export before the first send or replace its intake endpoint.
   * @param {string} endpoint Complete agentless trace intake URL
   * @param {string} apiKey Datadog API key
   */
  setAgentlessEndpoint (endpoint, apiKey) {
    if (this.#agentlessEndpoint === undefined) {
      this.#state.setAgentlessEndpoint(endpoint, apiKey)
      this.#agentlessEndpoint = endpoint
      this.#agentlessApiKey = apiKey
      return
    }

    const previousEndpoint = this.#agentlessEndpoint
    const previousApiKey = this.#agentlessApiKey
    this.#agentlessEndpoint = endpoint
    this.#agentlessApiKey = apiKey

    let state
    try {
      state = this.#createWasmState(this.#agentUrl)
    } catch (error) {
      this.#agentlessEndpoint = previousEndpoint
      this.#agentlessApiKey = previousApiKey
      throw error
    }

    const oldState = this.#state
    this.#state = state
    this.#releaseState(oldState)
  }

  /**
   * Select OTLP trace export before the first send.
   * @param {string} url OTLP HTTP traces endpoint
   */
  setOtlpEndpoint (url) {
    this.#state.setOtlpEndpoint(url)
    this.#otlpEndpoint = url
  }

  /**
   * Select the native OTLP wire protocol.
   * @param {string} protocol OTLP wire protocol
   */
  setOtlpProtocol (protocol) {
    this.#state.setOtlpProtocol(protocol)
    this.#otlpProtocol = protocol
  }

  /**
   * Set extra OTLP export headers.
   * @param {string[]} headers Flat key/value pairs
   */
  setOtlpHeaders (headers) {
    this.#state.setOtlpHeaders(headers)
    this.#otlpHeaders = [...headers]
  }

  /**
   * Rebuild native state for a new agent URL.
   * @param {string} url New agent URL
   */
  setAgentUrl (url) {
    const state = this.#createWasmState(url)
    const oldState = this.#state
    this.#agentUrl = url
    this.#state = state
    this.#releaseState(oldState)
    log.debug('Native spans interface reinitialized with new URL: %s', url)
  }

  /**
   * Transfer and send an encoded v0.4 trace payload.
   * @param {Uint8Array} payload Encoded trace chunks
   * @returns {Promise<string>} Native response body
   */
  sendEncodedTraces (payload) {
    const state = this.#state
    return this.#trackOperation(state, state.sendEncodedTraces(payload))
  }

  /**
   * Keep the stats API asynchronous even when the WASM boundary throws.
   * @param {boolean} force Whether to include partial buckets
   * @returns {Promise<boolean>} Whether a stats payload was sent
   */
  #flushStats (force) {
    const state = this.#state
    let operation
    try {
      operation = state.flushStats(force)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#trackOperation(state, operation).then(normalizeStatsFlushResult)
  }

  /**
   * Force-flush native stats, including partial buckets.
   * @returns {Promise<boolean>} Whether a stats payload was sent
   */
  flushStats () {
    if (!this.#options.statsEnabled) return Promise.resolve(true)
    return this.#flushStats(true)
  }
}

module.exports = NativeSpansInterface
