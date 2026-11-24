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
  #encoder
  #pendingFlushes = 0
  #flushCallbacks = []
  #flushError

  /**
   * @param {number | null} interprocessCode
   * @param {JSONEncoder | import('../../encode/trace-object-encoder')} [encoder]
   */
  constructor (interprocessCode, encoder = new JSONEncoder()) {
    this.#encoder = encoder
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
    this._isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
  }

  /**
   * Waits for earlier sends so finalization cannot close the worker with traces in flight.
   *
   * @param {(error?: Error) => void} [onDone]
   */
  flush (onDone) {
    const count = this.#encoder.count()
    if (onDone) this.#flushCallbacks.push(onDone)

    if (count > 0) {
      const payload = this.#encoder.makePayload()

      this.#pendingFlushes++
      this._sendPayload(payload, error => {
        this.#flushError ||= error
        this.#pendingFlushes--
        this.#finishFlush()
      })
    } else {
      this.#finishFlush()
    }
  }

  #finishFlush () {
    if (this.#pendingFlushes || !this.#flushCallbacks.length) return

    const callbacks = this.#flushCallbacks
    const error = this.#flushError
    this.#flushCallbacks = []
    this.#flushError = undefined
    for (const callback of callbacks) callback(error)
  }

  append (payload) {
    this.#encoder.encode(payload)
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
        log.error('Error posting message to vitest worker port', error)
      } finally {
        onDone()
      }
      return
    }

    // child_process workers (jest default, cucumber)
    if (process.send) {
      process.send(payload, (error) => {
        if (error) log.error('Error sending message to parent process', error)
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
        log.error('Error posting message to parent port', error)
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
