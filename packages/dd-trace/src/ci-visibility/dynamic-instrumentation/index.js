'use strict'

const { join } = require('path')
const { Worker, threadId: parentThreadId } = require('worker_threads')
const { randomUUID } = require('crypto')
const log = require('../../log')

const probeIdToResolveBreakpointSet = new Map()
const probeIdToResolveBreakpointRemove = new Map()

class TestVisDynamicInstrumentation {
  constructor () {
    this.worker = null
    this._readyPromise = new Promise(resolve => {
      this._onReady = resolve
    })
    this.breakpointSetChannel = new MessageChannel()
    this.breakpointHitChannel = new MessageChannel()
    this.breakpointRemoveChannel = new MessageChannel()
    this.onHitBreakpointByProbeId = new Map()
  }

  removeProbe (probeId) {
    return new Promise(resolve => {
      this.breakpointRemoveChannel.port2.postMessage(probeId)

      probeIdToResolveBreakpointRemove.set(probeId, resolve)
    })
  }

  // Return 2 elements:
  // 1. Probe ID
  // 2. Promise that's resolved when the breakpoint is set
  addLineProbe ({ file, line }, onHitBreakpoint) {
    const probeId = randomUUID()

    this.breakpointSetChannel.port2.postMessage(
      { id: probeId, file, line }
    )

    this.onHitBreakpointByProbeId.set(probeId, onHitBreakpoint)

    return [
      probeId,
      new Promise(resolve => {
        probeIdToResolveBreakpointSet.set(probeId, resolve)
      })
    ]
  }

  isReady () {
    return this._readyPromise
  }

  start (config) {
    if (this.worker) return

    log.debug('Starting Test Visibility - Dynamic Instrumentation client...')

    const rcChannel = new MessageChannel() // mock channel
    const configChannel = new MessageChannel() // mock channel

    this.worker = new Worker(
      join(__dirname, 'worker', 'index.js'),
      {
        execArgv: [],
        // Not passing `NODE_OPTIONS` results in issues with yarn, which relies on NODE_OPTIONS
        // for PnP support, hence why we deviate from the DI pattern here.
        // To avoid infinite initialization loops, we're disabling DI and tracing in the worker.
        env: {
          ...process.env,
          DD_TRACE_ENABLED: 0,
          DD_TEST_DYNAMIC_INSTRUMENTATION_ENABLED: 0
        },
        workerData: {
          config: config.serialize(),
          parentThreadId,
          rcPort: rcChannel.port1,
          configPort: configChannel.port1,
          breakpointSetChannel: this.breakpointSetChannel.port1,
          breakpointHitChannel: this.breakpointHitChannel.port1,
          breakpointRemoveChannel: this.breakpointRemoveChannel.port1
        },
        transferList: [
          rcChannel.port1,
          configChannel.port1,
          this.breakpointSetChannel.port1,
          this.breakpointHitChannel.port1,
          this.breakpointRemoveChannel.port1
        ]
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
    this.worker.unref()

    this.breakpointSetChannel.port2.on('message', (probeId) => {
      const resolve = probeIdToResolveBreakpointSet.get(probeId)
      if (resolve) {
        resolve()
        probeIdToResolveBreakpointSet.delete(probeId)
      }
    }).unref()

    this.breakpointHitChannel.port2.on('message', ({ snapshot }) => {
      const { probe: { id: probeId } } = snapshot
      const onHit = this.onHitBreakpointByProbeId.get(probeId)
      if (onHit) {
        onHit({ snapshot })
      } else {
        log.warn('Received a breakpoint hit for an unknown probe')
      }
    }).unref()

    this.breakpointRemoveChannel.port2.on('message', (probeId) => {
      const resolve = probeIdToResolveBreakpointRemove.get(probeId)
      if (resolve) {
        resolve()
        probeIdToResolveBreakpointRemove.delete(probeId)
      }
    }).unref()
  }
}

module.exports = new TestVisDynamicInstrumentation()
