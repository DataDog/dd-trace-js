'use strict'

const { join } = require('node:path')

const { channel } = require('dc-polyfill')

const { FLAG_EVALUATION_FLUSH_INTERVAL, FLAG_EVALUATION_QUEUE_CAP } = require('../constants/constants')
const { EVP_PROXY_PATH_V2 } = require('../../evp_proxy/constants')
const { getEnvironmentVariables } = require('../../config/helper')
const log = require('../../log')
const { normalizeFlagEvaluationEvent, normalizeTargetingKey } = require('./flag-evaluation-pii')
const {
  collectWorkerTelemetry, createWorkerState, recordDropped, recordTargetingKeyOmitted,
} = require('./flag-evaluation-telemetry')

const telemetryAppClosingCh = channel('datadog:telemetry:app-closing')

// Share clone/wakeup costs across event-loop turns without delaying sparse evaluations indefinitely.
const BATCH_SIZE = 64
const CONSENT_BATCH_SIZE = 8
const BATCH_DELAY_MS = 20

/** @typedef {import('./flag-evaluation-consumer').FlagEvaluationRoute} FlagEvaluationRoute */
/** @typedef {import('./flag-evaluation-aggregation').FlagEvaluationEvent} FlagEvaluationEvent */

/**
 * @typedef {object} SerializedFlagEvaluationRoute
 * @property {number} id
 * @property {string} url
 * @property {string} basePath
 * @property {object} [headers]
 * @property {boolean} onFallback
 * @property {boolean} onUnavailable
 * @property {SerializedFlagEvaluationRoute} [fallback]
 */

/**
 * @param {FlagEvaluationRoute} route
 * @param {number} id - Generation used to reject reports from obsolete routes
 */
function serializeRoute (route, id) {
  // Live custom agents cannot cross isolates. The common request helper recreates env proxy agents in the worker.
  if (route.agent) throw new Error('Custom EVP route agents are not supported in the flag evaluation worker')
  return {
    id,
    url: route.url.href,
    basePath: route.basePath,
    headers: route.headers,
    onFallback: typeof route.onFallback === 'function',
    onUnavailable: typeof route.onUnavailable === 'function',
    fallback: route.fallback ? serializeRoute(route.fallback, id) : undefined,
  }
}

class FlagEvaluationsWriter {
  #enabled = false
  #closed = false
  #failed = false
  #worker
  #state = createWorkerState()
  #batch = []
  #batchTimer
  #periodic
  #deadline
  #destroyer
  #onAppClosing
  #route
  #routeId = 0
  #serializedRoute
  #context
  #failureReason = 'worker_failure'

  /** @param {import('../../config/config-base')} config */
  constructor (config) {
    this.#route = { url: /** @type {URL} */ (config.url), basePath: EVP_PROXY_PATH_V2 }
    this.#context = {
      service: typeof config.service === 'string' ? config.service : '',
      env: typeof config.env === 'string' ? config.env : undefined,
      version: typeof config.version === 'string' ? config.version : undefined,
    }
    this.#destroyer = () => this.destroy()
    // Telemetry registers its shutdown sender before providers. Collect existing worker metrics before that send.
    // Metrics produced by the later final drain remain best-effort; this does not coordinate telemetry shutdown.
    this.#onAppClosing = () => collectWorkerTelemetry(this.#state)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.#destroyer)
    telemetryAppClosingCh.subscribe(this.#onAppClosing)
  }

  hasCapacity () {
    return this.getUnavailableReason() === undefined &&
      Atomics.load(this.#state, 0) < FLAG_EVALUATION_QUEUE_CAP && Atomics.load(this.#state, 1) < 0x7F_FF_F0_00
  }

  /** @returns {'closed' | 'worker_failure' | 'unavailable' | undefined} */
  getUnavailableReason () {
    if (this.#closed) return 'closed'
    if (this.#failed) return 'worker_failure'
    return this.#enabled ? undefined : 'unavailable'
  }

  /**
   * @param {boolean} enabled
   * @param {FlagEvaluationRoute} [route]
   */
  setEnabled (enabled, route) {
    if (this.#closed || this.#failed) return
    this.#routeId++
    if (route) this.#route = route
    if (!enabled) {
      this.#discardPartial('unavailable')
      this.#post({ type: 'enabled', enabled: false })
      this.#enabled = false
      return
    }
    try {
      this.#serializedRoute = serializeRoute(this.#route, this.#routeId)
      this.#post({ type: 'enabled', enabled: true, route: this.#serializedRoute })
      this.#enabled = !this.#failed
    } catch {
      this.#fail()
    }
  }

  /** @param {FlagEvaluationEvent} event */
  enqueue (event) {
    if (!this.hasCapacity()) {
      recordDropped(this.getUnavailableReason() ?? 'queue_overflow')
      return false
    }
    const targetingKey = normalizeTargetingKey(event.targetingKey)
    if (targetingKey === undefined && event.targetingKey !== undefined && event.targetingKey !== null) {
      recordTargetingKeyOmitted()
    }
    const normalized = normalizeFlagEvaluationEvent(event, targetingKey)
    const consent = normalized.observeFullEvaluationData
    Atomics.add(this.#state, 0, 1)
    Atomics.add(this.#state, 1, 1)
    this.#batch.push(normalized)
    // A consented event flushes any batch of 8+, so a mixed batch contains at most 8 context snapshots.
    if (this.#batch.length >= (consent ? CONSENT_BATCH_SIZE : BATCH_SIZE)) this.#sendBatch()
    else if (this.#batchTimer === undefined) {
      this.#batchTimer = setTimeout(() => this.#sendBatch(), BATCH_DELAY_MS)
      this.#batchTimer.unref?.()
    }
    return true
  }

  flush () {
    if (this.#closed || this.#failed) return
    this.#sendBatch()
    this.#post({ type: 'flush' })
    collectWorkerTelemetry(this.#state)
  }

  destroy () {
    if (this.#closed) return
    this.#sendBatch()
    this.#closed = true
    this.#enabled = false
    this.#cleanup()
    if (!this.#worker || this.#failed) return
    // Keep only a bounded final drain alive. An unresponsive worker can delay graceful
    // exit by up to five seconds; unref'ing the deadline would not bypass the ref'd worker.
    // Ordinary traffic and idle workers never keep the app alive.
    this.#worker.ref()
    this.#deadline = setTimeout(() => {
      this.#failureReason = 'shutdown_timeout'
      this.#fail()
    }, 5000)
    this.#post({ type: 'close' })
  }

  #sendBatch () {
    this.#cancelBatchTimer()
    if (this.#batch.length === 0) return
    if (!this.#worker) {
      this.#startWorker()
      if (this.#failed) return
    }
    const events = this.#batch
    this.#batch = []
    this.#post({ type: 'batch', events })
  }

  // Providers that never evaluate need no worker. A first batch during destroy still uses the bounded drain.
  #startWorker () {
    try {
      const { Worker } = require('node:worker_threads')
      // Intentionally use the tracer's supported-config filter (which retains non-DD/OTEL env).
      // Strip preloads so the worker cannot initialize the application tracer recursively.
      const { NODE_OPTIONS, ...env } = getEnvironmentVariables()
      this.#worker = new Worker(join(__dirname, 'flag-evaluation-worker.js'), {
        name: 'dd-flag-evaluation',
        execArgv: [],
        env,
        workerData: { route: this.#serializedRoute, context: this.#context, state: this.#state.buffer },
      })
      this.#worker.on('error', error => this.#fail(
        error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND' ? 'missing_module' : 'worker_error'
      ))
      this.#worker.on('messageerror', () => this.#fail('message_error'))
      this.#worker.on('message', message => this.#onRouteMessage(message))
      this.#worker.once('exit', () => this.#exited())
      this.#worker.unref?.()
      this.#periodic = setInterval(() => collectWorkerTelemetry(this.#state), FLAG_EVALUATION_FLUSH_INTERVAL)
      this.#periodic.unref?.()
    } catch {
      this.#fail('startup_error')
    }
  }

  /** @param {{ type: 'route', id: number, status: 'fallback' | 'unavailable' }} message */
  #onRouteMessage (message) {
    if (this.#closed || this.#failed || !this.#enabled ||
      message?.type !== 'route' || message.id !== this.#routeId) return
    const callback = message.status === 'fallback'
      ? this.#route.onFallback
      : message.status === 'unavailable' ? this.#route.onUnavailable : undefined
    if (!callback) return
    // Consume the transition once. The strategy may synchronously publish a replacement route.
    this.#routeId++
    try {
      callback()
    } catch {
      this.#fail('route_error')
    }
  }

  /** @param {object} message */
  #post (message) {
    if (!this.#worker || this.#failed) return
    try {
      this.#worker.postMessage(message)
    } catch {
      this.#fail()
    }
  }

  #cancelBatchTimer () {
    if (this.#batchTimer !== undefined) clearTimeout(this.#batchTimer)
    this.#batchTimer = undefined
  }

  /** @param {string} reason */
  #discardPartial (reason) {
    this.#cancelBatchTimer()
    const count = this.#batch.length
    this.#batch = []
    Atomics.sub(this.#state, 0, count)
    Atomics.sub(this.#state, 1, count)
    recordDropped(reason, count)
  }

  #cleanup () {
    clearInterval(this.#periodic)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
    telemetryAppClosingCh.unsubscribe(this.#onAppClosing)
    collectWorkerTelemetry(this.#state)
  }

  /** @param {string} [reason] - Internal diagnostic only; never include raw error messages or paths. */
  #fail (reason = 'worker_error') {
    if (this.#failed) return
    this.#failed = true
    this.#enabled = false
    this.#cancelBatchTimer()
    this.#batch = []
    this.#cleanup()
    log.warn('Flag evaluation counts disabled after worker failure (%s)', reason)
    if (this.#worker) this.#worker.terminate()
    else this.#exited()
  }

  #exited () {
    clearTimeout(this.#deadline)
    this.#failed = true
    this.#enabled = false
    this.#worker = undefined
    this.#cancelBatchTimer()
    this.#batch = []
    this.#cleanup()
    // Only settle ownership once the worker cannot mutate counters anymore.
    recordDropped(this.#failureReason, Atomics.exchange(this.#state, 1, 0))
    Atomics.store(this.#state, 0, 0)
  }
}

module.exports = FlagEvaluationsWriter
