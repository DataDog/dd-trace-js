const { join } = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')

/**
 * TODOS:
 * - console.log -> log
 */

const messages = new Map()

class TestVisDynamicInstrumentation {
  constructor (config) {
    this.worker = null
    this.config = config // do I need config?
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

    // TODO: do not use global for this
    global._activateDebugger = ({ file, line }) => {
      return new Promise(resolve => {
        const id = randomUUID()
        messages.set(id, resolve)
        console.log('asking worker to add breakpoint', { id, file, line })
        this.worker.postMessage({ probe: { id, file, line } })
      })
    }

    this.worker.on('message', ({ id, probe, state }) => {
      console.log('response from worker', { id, probe, state })
      const resolve = messages.get(id)
      resolve({ probe, state })
      messages.delete(id)
    }).unref()
  }
}

module.exports = TestVisDynamicInstrumentation
