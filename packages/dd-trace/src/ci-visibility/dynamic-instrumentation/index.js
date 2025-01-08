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
    // breakpointRemoveChannel
    return new Promise(resolve => {
      this.breakpointRemoveChannel.port2.postMessage(probeId)

      probeIdToResolveBreakpointRemove.set(probeId, resolve)
    })
  }

  // Return 3 elements:
  // 1. Snapshot ID
  // 2. Promise that's resolved when the breakpoint is set
  // 3. Promise that's resolved when the breakpoint is hit
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

    const { NODE_OPTIONS, ...envWithoutNodeOptions } = process.env

    log.debug('Starting Test Visibility - Dynamic Instrumentation client...')

    const rcChannel = new MessageChannel() // mock channel
    const configChannel = new MessageChannel() // mock channel

    this.worker = new Worker(
      join(__dirname, 'worker', 'index.js'),
      {
        execArgv: [],
        env: envWithoutNodeOptions,
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
