'use strict'

const { join } = require('node:path')

const { channel } = require('dc-polyfill')

const { FLAG_EVALUATION_FLUSH_INTERVAL, FLAG_EVALUATION_QUEUE_CAP } = require('../constants/constants')
const { EVP_PROXY_PATH_V2 } = require('../../evp_proxy/constants')
const { getEnvironmentVariables } = require('../../config/helper')
const log = require('../../log')
const { normalizeTargetingKey, optionalKey, protectedErrorCode } = require('./flag-evaluation-pii')
const {
  collectWorkerTelemetry, createWorkerState, recordDropped, recordTargetingKeyOmitted,
} = require('./flag-evaluation-telemetry')

const telemetryAppClosingCh = channel('datadog:telemetry:app-closing')

/** @typedef {import('./flag-evaluation-consumer').FlagEvaluationRoute} FlagEvaluationRoute */
/** @typedef {import('./flag-evaluation-aggregation').FlagEvaluationEvent} FlagEvaluationEvent */

/** @param {FlagEvaluationRoute} route */
function serializeRoute (route) {
  // Live custom agents cannot cross isolates. The common request helper recreates env proxy agents in the worker.
  if (route.agent) throw new Error('Custom EVP route agents are not supported in the flag evaluation worker')
  return {
    url: route.url.href,
    basePath: route.basePath,
    headers: route.headers,
    fallback: route.fallback ? serializeRoute(route.fallback) : undefined,
  }
}

class FlagEvaluationsWriter {
  #enabled = false
  #closed = false
  #failed = false
  #worker
  #state = createWorkerState()
  #batch = []
  #immediate
  #periodic
  #deadline
  #destroyer
  #onAppClosing
  #route
  #serializedRoute
  #context
  #failureReason = 'worker_failure'

  /**
   * @param {import('../../config/config-base')} config
   * @param {FlagEvaluationRoute} [route]
   */
  constructor (config, route) {
    this.#route = route ?? { url: /** @type {URL} */ (config.url), basePath: EVP_PROXY_PATH_V2 }
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
    if (route) this.#route = route
    if (!enabled) {
      this.#discardPartial('unavailable')
      this.#post({ type: 'enabled', enabled: false })
      this.#enabled = false
      return
    }
    try {
      this.#serializedRoute = serializeRoute(this.#route)
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
    const consent = event.observeFullEvaluationData === true
    const normalized = {
      flagKey: normalizeTargetingKey(event.flagKey),
      variant: optionalKey(event.variant),
      allocationKey: optionalKey(event.allocationKey),
      targetingRuleKey: optionalKey(event.targetingRuleKey),
      runtimeDefault: event.runtimeDefault === true,
      errorCode: protectedErrorCode(event.errorCode),
      targetingKey,
      attrs: consent ? event.attrs : undefined,
      observeFullEvaluationData: consent,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : NaN,
    }
    Atomics.add(this.#state, 0, 1)
    Atomics.add(this.#state, 1, 1)
    this.#batch.push(normalized)
    if (this.#batch.length === 8) this.#sendBatch()
    else if (this.#immediate === undefined) {
      this.#immediate = setImmediate(() => this.#sendBatch())
      this.#immediate.unref?.()
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
    this.#cancelImmediate()
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
      this.#worker.on('error', () => this.#fail())
      this.#worker.on('messageerror', () => this.#fail())
      this.#worker.once('exit', () => this.#exited())
      this.#worker.unref?.()
      this.#periodic = setInterval(() => collectWorkerTelemetry(this.#state), FLAG_EVALUATION_FLUSH_INTERVAL)
      this.#periodic.unref?.()
    } catch {
      this.#fail()
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

  #cancelImmediate () {
    if (this.#immediate !== undefined) clearImmediate(this.#immediate)
    this.#immediate = undefined
  }

  /** @param {string} reason */
  #discardPartial (reason) {
    this.#cancelImmediate()
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

  #fail () {
    if (this.#failed) return
    this.#failed = true
    this.#enabled = false
    this.#cancelImmediate()
    this.#batch = []
    this.#cleanup()
    log.debug('Flag evaluation worker stopped; disabling this writer')
    if (this.#worker) this.#worker.terminate()
    else this.#exited()
  }

  #exited () {
    clearTimeout(this.#deadline)
    this.#failed = true
    this.#enabled = false
    this.#worker = undefined
    this.#cancelImmediate()
    this.#batch = []
    this.#cleanup()
    // Only settle ownership once the worker cannot mutate counters anymore.
    recordDropped(this.#failureReason, Atomics.exchange(this.#state, 1, 0))
    Atomics.store(this.#state, 0, 0)
  }
}

module.exports = FlagEvaluationsWriter
