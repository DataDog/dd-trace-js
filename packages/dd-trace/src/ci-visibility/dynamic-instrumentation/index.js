'use strict'

const { join } = require('path')
const { Worker, threadId: parentThreadId } = require('worker_threads')
const { randomUUID } = require('crypto')
const log = require('../../log')
const { getEnvironmentVariables } = require('../../config/helper')
const getDebuggerConfig = require('../../debugger/config')

const drainRequestIdToResolveBreakpointHit = new Map()

/**
 * @typedef {object} ProbeState
 * @property {string} locationKey
 * @property {(breakpoint: object) => void} onHitBreakpoint
 * @property {Promise<void>|undefined} removePromise
 * @property {(() => void)|undefined} resolveRemove
 * @property {(() => void)|undefined} resolveSet
 * @property {Promise<void>} setPromise
 * @property {boolean} setPosted
 */

class TestVisDynamicInstrumentation {
  /** @type {Map<string, Promise<void>>} */
  #pendingProbeRemovalByLocation = new Map()
  /** @type {Map<string, ProbeState>} */
  #probeStateById = new Map()

  /**
   * @param {import('../../config/config-base')} config - Tracer configuration
   */
  constructor (config) {
    this._config = config
    this.worker = null
    this._readyPromise = new Promise(resolve => {
      this._onReady = resolve
    })
    this.breakpointSetChannel = new MessageChannel()
    this.breakpointHitChannel = new MessageChannel()
    this.breakpointRemoveChannel = new MessageChannel()
  }

  /**
   * @param {string|undefined} probeId
   */
  removeProbe (probeId) {
    const probeState = probeId === undefined ? undefined : this.#probeStateById.get(probeId)
    if (!probeState) return Promise.resolve()
    if (probeState.removePromise) return probeState.removePromise

    if (!probeState.setPosted) {
      this.#probeStateById.delete(probeId)
      probeState.resolveSet?.()
      probeState.resolveSet = undefined
      return Promise.resolve()
    }

    const postRemoval = () => new Promise(resolve => {
      probeState.resolveRemove = resolve
      this.breakpointRemoveChannel.port2.postMessage(probeId)
    })
    const removeAcknowledgedPromise = probeState.setPromise.then(postRemoval)
    const removePromise = removeAcknowledgedPromise.then(() => this.waitForInFlightBreakpointHits())
    probeState.removePromise = removePromise
    this.#pendingProbeRemovalByLocation.set(probeState.locationKey, removeAcknowledgedPromise)
    removeAcknowledgedPromise.then(() => {
      if (this.#pendingProbeRemovalByLocation.get(probeState.locationKey) === removeAcknowledgedPromise) {
        this.#pendingProbeRemovalByLocation.delete(probeState.locationKey)
      }
    })
    removePromise.then(() => {
      if (this.#probeStateById.get(probeId) === probeState) {
        this.#probeStateById.delete(probeId)
      }
    })
    return removePromise
  }

  /**
   * @param {{ file: string, line: number }} location
   * @param {(breakpoint: object) => void} onHitBreakpoint
   */
  addLineProbe ({ file, line }, onHitBreakpoint) {
    if (!this.worker) { // not init yet
      this.start()
    }
    const probeId = randomUUID()
    const locationKey = `${file}:${line}`
    const pendingRemoval = this.#pendingProbeRemovalByLocation.get(locationKey)

    let resolveSet
    const setProbePromise = new Promise(resolve => {
      resolveSet = resolve
    })
    const probeState = {
      locationKey,
      onHitBreakpoint,
      removePromise: undefined,
      resolveRemove: undefined,
      resolveSet,
      setPromise: setProbePromise,
      setPosted: false,
    }
    this.#probeStateById.set(probeId, probeState)

    const setProbe = () => {
      if (this.#probeStateById.get(probeId) === probeState) {
        probeState.setPosted = true
        this.breakpointSetChannel.port2.postMessage(
          { id: probeId, file, line }
        )
      }
    }
    if (pendingRemoval) {
      pendingRemoval.then(setProbe)
    } else {
      setProbe()
    }

    return [
      probeId,
      setProbePromise,
    ]
  }

  /**
   * Waits until all breakpoint hits already being handled by the DI worker have been posted back.
   *
   * @returns {Promise<void>}
   */
  waitForInFlightBreakpointHits () {
    if (!this.worker) return Promise.resolve()

    const requestId = randomUUID()
    return new Promise(resolve => {
      drainRequestIdToResolveBreakpointHit.set(requestId, resolve)
      this.breakpointHitChannel.port2.postMessage({ drainRequestId: requestId })
    })
  }

  isReady () {
    return this._readyPromise
  }

  start () {
    if (this.worker) return

    log.debug('Starting Test Visibility - Dynamic Instrumentation client...')

    const probeChannel = new MessageChannel() // mock channel
    const configChannel = new MessageChannel() // mock channel

    this.worker = new Worker(
      join(__dirname, 'worker', 'index.js'),
      {
        execArgv: [],
        // Not passing `NODE_OPTIONS` results in issues with yarn, which relies on NODE_OPTIONS
        // for PnP support, hence why we deviate from the DI pattern here.
        // To avoid infinite initialization loops, we're disabling DI and tracing in the worker.
        env: {
          // NOTE: We intentionally use `getEnvironmentVariables()` here (raw env)
          // instead of stable-config resolution helpers. The DI worker is a forked
          // process that should see exactly the parent process's environment, and
          // we explicitly override a few DD_ vars below to disable tracing/DI there.
          ...getEnvironmentVariables(),
          DD_CIVISIBILITY_ENABLED: 'false',
          DD_TRACE_ENABLED: 'false',
          DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
          DD_CIVISIBILITY_MANUAL_API_ENABLED: 'false',
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        },
        workerData: {
          config: getDebuggerConfig(this._config),
          parentThreadId,
          probePort: probeChannel.port1,
          configPort: configChannel.port1,
          breakpointSetChannel: this.breakpointSetChannel.port1,
          breakpointHitChannel: this.breakpointHitChannel.port1,
          breakpointRemoveChannel: this.breakpointRemoveChannel.port1,
        },
        transferList: [
          probeChannel.port1,
          configChannel.port1,
          this.breakpointSetChannel.port1,
          this.breakpointHitChannel.port1,
          this.breakpointRemoveChannel.port1,
        ],
      }
    )
    this.worker.on('online', () => {
      log.debug('Test Visibility - Dynamic Instrumentation client is ready')
      this._onReady()
    })

    this.worker.on('error', (err) => {
      log.error('Test Visibility - Dynamic Instrumentation worker error', err)
    })

    this.worker.on('messageerror', (err) => {
      log.error('Test Visibility - Dynamic Instrumentation worker messageerror', err)
    })

    // Allow the parent to exit even if the worker is still running
    this.worker.unref?.()

    this.breakpointSetChannel.port2.on('message', (probeId) => {
      const probeState = this.#probeStateById.get(probeId)
      if (probeState?.resolveSet) {
        probeState.resolveSet()
        probeState.resolveSet = undefined
      }
    }).unref?.()

    this.breakpointHitChannel.port2.on('message', ({ snapshot, drainRequestId }) => {
      if (drainRequestId) {
        const resolve = drainRequestIdToResolveBreakpointHit.get(drainRequestId)
        if (resolve) {
          resolve()
          drainRequestIdToResolveBreakpointHit.delete(drainRequestId)
        }
        return
      }

      const { probe: { id: probeId } } = snapshot
      const probeState = this.#probeStateById.get(probeId)
      if (probeState) {
        probeState.onHitBreakpoint({ snapshot })
      } else {
        log.warn('Received a breakpoint hit for an unknown probe')
      }
    }).unref?.()

    this.breakpointRemoveChannel.port2.on('message', (probeId) => {
      const probeState = this.#probeStateById.get(probeId)
      if (probeState?.resolveRemove) {
        probeState.resolveRemove()
        probeState.resolveRemove = undefined
      }
    }).unref?.()
  }
}

let dynamicInstrumentation

/**
 * @param {import('../../config/config-base')} config - Tracer configuration
 */
module.exports = function createAndGetTestVisDynamicInstrumentation (config) {
  if (dynamicInstrumentation) {
    return dynamicInstrumentation
  }
  dynamicInstrumentation = new TestVisDynamicInstrumentation(config)
  return dynamicInstrumentation
}
