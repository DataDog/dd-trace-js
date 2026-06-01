'use strict'
const { JSONEncoder } = require('../../encode/json-encoder')
const { getEnvironmentVariable } = require('../../../config/helper')
const log = require('../../../log')

class Writer {
  constructor (interprocessCode) {
    this._encoder = new JSONEncoder()
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
  }

  flush (onDone) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, onDone)
    }
  }

  append (payload) {
    this._encoder.encode(payload)
  }

  _sendPayload (data, onDone = () => {}) {
    // ## Cucumber
    // This reports to the test's main process the same way test data is reported by Cucumber
    // See cucumber code:
    // https://github.com/cucumber/cucumber-js/blob/5ce371870b677fe3d1a14915dc535688946f734c/src/runtime/parallel/run_worker.ts#L13

    // Old because vitest@>=4 uses `DD_VITEST_WORKER` and reports arrays just like other frameworks
    // Before vitest@>=4, we need the `__tinypool_worker_message__` property, or tinypool will crash
    const isVitestWorkerOld = !!getEnvironmentVariable('TINYPOOL_WORKER_ID')
    const payload = isVitestWorkerOld
      ? { __tinypool_worker_message__: true, interprocessCode: this._interprocessCode, data }
      : [this._interprocessCode, data]

    // child_process workers (jest default, cucumber)
    if (process.send) {
      process.send(payload, () => {
        onDone()
      })
      return
    }

    // worker_threads (jest --workerThreads, vitest)
    const { isMainThread, parentPort } = require('node:worker_threads')
    if (!isMainThread && parentPort) {
      try {
        parentPort.postMessage(payload)
      } catch (error) {
        log.error('Error posting message to parent port', error)
      } finally {
        onDone()
      }
      return
    }

    onDone()
  }
}

module.exports = Writer
