'use strict'

const { join } = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')
const log = require('../../log')

const probeIdToResolvePromise = new Map()

class TestVisDynamicInstrumentation {
  constructor () {
    this.worker = null
  }

  // Return the snapshot id and a promise that's resolved if the breakpoint is hit
  addLineProbe ({ file, line }) {
    const snapshotId = randomUUID()

    return [
      snapshotId,
      new Promise(resolve => {
        const probeId = randomUUID()
        probeIdToResolvePromise.set(probeId, resolve)
        this.worker.postMessage({
          snapshotId,
          probe: { id: probeId, file, line }
        })
      })
    ]
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

    // Allow the parent to exit even if the worker is still running
    this.worker.unref()

    this.worker.on('message', ({ snapshot }) => {
      const { probe: { id: probeId } } = snapshot
      const resolve = probeIdToResolvePromise.get(probeId)
      if (resolve) {
        resolve({ snapshot })
        probeIdToResolvePromise.delete(probeId)
      }
    }).unref() // We also need to unref this message handler
  }
}

module.exports = new TestVisDynamicInstrumentation()
