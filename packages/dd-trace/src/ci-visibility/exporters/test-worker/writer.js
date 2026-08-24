'use strict'
const { JSONEncoder } = require('../../encode/json-encoder')
const { getEnvironmentVariable } = require('../../../config/helper')
const log = require('../../../log')
const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
} = require('./webdriverio')

function getVitestWorkerPort () {
  const port = globalThis.__vitest_worker__?.ctx?.port
  return typeof port?.postMessage === 'function' ? port : undefined
}

class Writer {
  constructor (interprocessCode) {
    this._encoder = new JSONEncoder()
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
    this._isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
  }

  /**
   * @param {(error?: Error) => void} [onDone]
   */
  flush (onDone) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, onDone)
    } else {
      onDone?.()
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
    let payload = isVitestWorkerOld
      ? { __tinypool_worker_message__: true, interprocessCode: this._interprocessCode, data }
      : [this._interprocessCode, data]
    if (this._isWebdriverioWorker) {
      payload = createWebdriverioWorkerMessage(payload)
    }

    const vitestWorkerPort = getVitestWorkerPort()
    if (vitestWorkerPort) {
      try {
        vitestWorkerPort.postMessage(payload)
      } catch (error) {
        log.errorWithoutTelemetry('Error posting message to vitest worker port', error)
      } finally {
        onDone()
      }
      return
    }

    // child_process workers (jest default, cucumber)
    if (process.send) {
      process.send(payload, (error) => {
        if (error) log.errorWithoutTelemetry('Error sending message to parent process', error)
        onDone(error)
      })
      return
    }

    // worker_threads (jest --workerThreads, vitest)
    const { isMainThread, parentPort } = require('node:worker_threads')
    if (!isMainThread && parentPort) {
      try {
        parentPort.postMessage(payload)
      } catch (error) {
        log.errorWithoutTelemetry('Error posting message to parent port', error)
        onDone(error)
        return
      }
      // postMessage has no acknowledgement callback. Completion means the
      // message was accepted by the local port, not processed by the parent.
      onDone()
      return
    }

    onDone()
  }
}

module.exports = Writer
