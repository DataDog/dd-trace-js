const { join } = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')

/**
 * TODOS:
 * - console.log -> log
 */

global.__snapshotId = randomUUID()

const messages = new Map()

class TestVisDynamicInstrumentation {
  constructor (config) {
    this.worker = null
    this.config = config // do I need config?
  }

  // returns a promise that's resolved when the breakpoint is hit
  activateDebugger ({ file, line }) {
    return new Promise(resolve => {
      const id = randomUUID()
      messages.set(id, resolve)
      this.worker.postMessage({ snapshotId: global.__snapshotId, probe: { id, file, line } })
    })
  }

  start () {
    if (this.worker) return

    const { NODE_OPTIONS, ...env } = process.env

    console.log('Starting Dynamic Instrumentation client...')

    this.worker = new Worker(
      join(__dirname, 'worker', 'index.js'),
      {
        execArgv: [], // Avoid worker thread inheriting the `-r` command line argument
        env // Avoid worker thread inheriting the `NODE_OPTIONS` environment variable (in case it contains `-r`)
      }
    )

    // allow the parent to exit even if the worker is still running
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
