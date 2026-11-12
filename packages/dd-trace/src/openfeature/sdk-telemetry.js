'use strict'

const { performance } = require('node:perf_hooks')

const { VERSION } = require('../../../../version')
const SDKDiagnosticsWriter = require('./writers/sdk-diagnostics')

const ERROR_INTERVAL_MS = 60_000
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const MIN_TIMESTAMP_MS = 946_684_800_000
const MAX_TIMESTAMP_MS = 4_102_444_800_000

/** @param {unknown} value */
function validIdentity (value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/\p{Cc}/u.test(value)
}

/** Observations only: a success never clears another provider's error. */
class SDKTelemetry {
  #config
  #writer
  #startedAt
  #startedMonotonic
  #configurationElapsed
  #finished = false
  #closed = false
  #fetchFailed = false
  #lastErrorAt = -Infinity

  /** @param {import('../config/config-base')} config */
  static create (config) {
    if (!validIdentity(config.service) || !validIdentity(config.env)) return
    return new SDKTelemetry(config)
  }

  /** @param {import('../config/config-base')} config */
  constructor (config) {
    this.#config = config
  }

  /** @param {boolean} hasConfiguration */
  start (hasConfiguration) {
    if (this.#closed || this.#startedAt !== undefined) return
    this.#startedAt = Date.now()
    this.#startedMonotonic = performance.now()
    if (hasConfiguration) this.#configurationElapsed = 0
    const { service, env } = this.#config
    if (!validIdentity(service) || !validIdentity(env) ||
      this.#startedAt < MIN_TIMESTAMP_MS || this.#startedAt > MAX_TIMESTAMP_MS) return
    try {
      // Give route discovery time to finish before an observation is needed, as evaluation delivery does.
      this.#writer = new SDKDiagnosticsWriter(this.#config)
    } catch { /* Diagnostics must not affect provider initialization. */ }
  }

  configurationReceived () {
    if (this.#startedAt !== undefined && !this.#finished && this.#configurationElapsed === undefined) {
      this.#configurationElapsed = this.#elapsed()
    }
  }

  /** @param {'ready' | 'failed' | 'incomplete'} outcome */
  finish (outcome) {
    if (this.#closed || this.#finished || this.#startedAt === undefined) return
    this.#finished = true
    const duration = this.#elapsed()
    // Match intake's timing constraints without inventing a shorter initialization.
    if (this.#startedAt < MIN_TIMESTAMP_MS || Date.now() < this.#startedAt || duration > MAX_DURATION_MS) return
    const milestones = {}
    if (this.#configurationElapsed !== undefined) {
      milestones.configuration_received = { elapsed_ms: this.#configurationElapsed }
    }
    if (outcome === 'ready') milestones.provider_ready = { elapsed_ms: duration }
    const fields = {
      event_type: 'sdk_initialization',
      initialization: {
        outcome,
        started_at_ms: this.#startedAt,
        duration_ms: duration,
        final: outcome !== 'incomplete',
        milestones,
      },
    }
    if (outcome === 'failed') fields.error_code = 'INIT_FAILED'
    else if (outcome === 'incomplete') fields.initialization.reason = 'provider_closed'
    this.#emit(fields)
  }

  /** @param {boolean} success - Result of a completed fetch, after retries. */
  fetchResult (success) {
    if (this.#closed) return
    if (success) {
      this.#fetchFailed = false
      return
    }
    // Startup failures are represented by the initialization result.
    if (!this.#finished || this.#fetchFailed) return
    this.#fetchFailed = true
    const now = performance.now()
    if (now - this.#lastErrorAt < ERROR_INTERVAL_MS) return
    this.#lastErrorAt = now
    this.#emit({ event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED' })
  }

  close () {
    if (this.#closed) return
    this.finish('incomplete')
    this.#closed = true
    try {
      this.#writer?.destroy()
    } catch { /* Diagnostics must not affect provider shutdown. */ }
  }

  #elapsed () {
    return Math.max(0, performance.now() - this.#startedMonotonic)
  }

  /** @param {object} fields */
  #emit (fields) {
    const timestamp = Date.now()
    const { service, env } = this.#config
    // Do not invent identities that cannot be queried through the diagnostics API.
    if (!validIdentity(service) || !validIdentity(env) ||
      timestamp < MIN_TIMESTAMP_MS || timestamp > MAX_TIMESTAMP_MS) return
    try {
      this.#writer?.append({
        type: 'sdk_diagnostic',
        schema_version: 1,
        payload: {
          timestamp,
          sdk_name: 'dd-trace-js',
          sdk_version: VERSION,
          service_id: service,
          environment: env,
          ...fields,
        },
      })
    } catch { /* Diagnostics must not change initialization, polling or evaluations. */ }
  }
}

module.exports = SDKTelemetry
