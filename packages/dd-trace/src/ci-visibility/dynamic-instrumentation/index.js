'use strict'

const { join } = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')
const log = require('../../log')
const { BREAKPOINT_HIT, BREAKPOINT_SET } = require('./messages')

const probeIdToResolveBreakpointSet = new Map()
const probeIdToResolveBreakpointHit = new Map()

class TestVisDynamicInstrumentation {
  constructor () {
    this.worker = null
    this._readyPromise = new Promise(resolve => {
      this._onReady = resolve
    })
  }

  // Return 3 elements:
  // 1. Snapshot ID
  // 2. Promise that's resolved when the breakpoint is set
  // 3. Promise that's resolved when the breakpoint is hit
  addLineProbe ({ file, line }) {
    const snapshotId = randomUUID()
    const probeId = randomUUID()

    this.worker.postMessage({
      snapshotId,
      probe: { id: probeId, file, line }
    })

    return [
      snapshotId,
      new Promise(resolve => {
        probeIdToResolveBreakpointSet.set(probeId, resolve)
      }),
      new Promise(resolve => {
        probeIdToResolveBreakpointHit.set(probeId, resolve)
      })
    ]
  }

  isReady () {
    return this._readyPromise
  }

  start () {
    if (this.worker) return

    const { NODE_OPTIONS, ...envWithoutNodeOptions } = process.env

    log.debug('Starting Test Visibility - Dynamic Instrumentation client...')

    this.worker = new Worker(
      join(__dirname, 'worker', 'index.js'),
      {
        execArgv: [],
        env: envWithoutNodeOptions
      }
    )
    this.worker.on('online', () => {
      log.debug('Test Visibility - Dynamic Instrumentation client is ready')
      this._onReady()
    })

    // Allow the parent to exit even if the worker is still running
    this.worker.unref()

    this.worker.on('message', (message) => {
      const { type } = message
      if (type === BREAKPOINT_SET) {
        const { probeId } = message
        const resolve = probeIdToResolveBreakpointSet.get(probeId)
        if (resolve) {
          resolve()
          probeIdToResolveBreakpointSet.delete(probeId)
        }
      } else if (type === BREAKPOINT_HIT) {
        const { snapshot } = message
        const { probe: { id: probeId } } = snapshot
        const resolve = probeIdToResolveBreakpointHit.get(probeId)
        if (resolve) {
          resolve({ snapshot })
          probeIdToResolveBreakpointHit.delete(probeId)
        }
      }
    }).unref() // We also need to unref this message handler
  }
}

module.exports = new TestVisDynamicInstrumentation()
