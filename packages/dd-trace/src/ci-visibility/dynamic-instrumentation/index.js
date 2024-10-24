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

    return [
      snapshotId,
      new Promise(resolve => {
        const id = randomUUID()
        messages.set(id, resolve)
        this.worker.postMessage({
          snapshotId,
          probe: { id, file, line }
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

    this.worker.on('message', ({ id, probe, state, stack, snapshot }) => {
      const resolve = messages.get(id)
      if (resolve) {
        resolve({ probe, state, stack, snapshot })
        messages.delete(id)
      }
    }).unref()
  }
}

let testVisDynamicInstrumentation = null

module.exports = (config) => {
  if (!testVisDynamicInstrumentation) {
    testVisDynamicInstrumentation = new TestVisDynamicInstrumentation(config)
  }

  return testVisDynamicInstrumentation
}
