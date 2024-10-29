const { join } = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')

/**
 * TODO:
 * - console.log -> log
 */

const messages = new Map()

class TestVisDynamicInstrumentation {
  constructor (config) {
    this.worker = null
    this.config = config // do I need config?
  }

  // Return a promise that's resolved when the breakpoint is hit
  activateDebugger ({ file, line }) {
    const snapshotId = randomUUID()

    // we need the snapshotId before we hit the breakpoint so that
    // it is added to the test event.
    // That's why we add it here
    return [
      snapshotId,
      new Promise(resolve => {
        const probeId = randomUUID()
        messages.set(probeId, resolve)
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

    console.log('Starting Dynamic Instrumentation client...')

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
      const resolve = messages.get(probeId)
      if (resolve) {
        resolve({ snapshot })
        messages.delete(probeId)
      }
    }).unref()
  }
}

module.exports = new TestVisDynamicInstrumentation()
