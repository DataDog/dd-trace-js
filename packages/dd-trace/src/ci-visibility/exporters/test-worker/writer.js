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
  #onTraceBatch
  #traceFlush

  /**
   * @param {number | null} interprocessCode
   * @param {number} [traceBatchBytes]
   */
  constructor (interprocessCode, traceBatchBytes) {
    this._encoder = new JSONEncoder(traceBatchBytes)
    if (traceBatchBytes !== undefined) {
      this.#onTraceBatch = this.#sendTraceBatch.bind(this)
    }
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
    this._isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
  }

  /**
   * @param {(error?: Error) => void} [onDone]
   */
  flush (onDone) {
    if (this.#onTraceBatch !== undefined) {
      this.#flushTraceBatches(onDone)
      return
    }
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, onDone)
    } else {
      onDone?.()
    }
  }

  append (payload) {
    if (this.#onTraceBatch === undefined) {
      this._encoder.encode(payload)
      return
    }
    try {
      this._encoder.encode(payload, this.#onTraceBatch)
    } catch (error) {
      log.error('Error encoding test worker trace: %s', error)
    }
  }

  /**
   * @param {(error?: Error) => void} [onDone]
   */
  #flushTraceBatches (onDone) {
    if (this._encoder.count() > 0) {
      this.#sendTraceBatch(this._encoder.makePayload())
    }
    const traceFlush = this.#traceFlush
    this.#traceFlush = undefined
    if (traceFlush?.pending > 0) {
      traceFlush.onDone = onDone
    } else {
      onDone?.(traceFlush?.error)
    }
  }

  /**
   * @param {string[]} parts
   */
  #sendTraceBatch (parts) {
    const traceFlush = this.#traceFlush ??= { pending: 0, error: undefined, onDone: undefined }
    traceFlush.pending++
    this._sendPayload(parts, (error) => {
      traceFlush.error ||= error
      if (--traceFlush.pending === 0) {
        traceFlush.onDone?.(traceFlush.error)
      }
    })
  }

  _sendPayload (data, onDone = () => {}) {
    // ## Cucumber
    // This reports to the test's main process the same way test data is reported by Cucumber
    // See cucumber code:
    // https://github.com/cucumber/cucumber-js/blob/5ce371870b677fe3d1a14915dc535688946f734c/src/runtime/parallel/run_worker.ts#L13

    try {
      const serialized = Array.isArray(data) ? data.join('') : data
      // Old because vitest@>=4 uses `DD_VITEST_WORKER` and reports arrays just like other frameworks
      // Before vitest@>=4, we need the `__tinypool_worker_message__` property, or tinypool will crash
      const isVitestWorkerOld = !!getEnvironmentVariable('TINYPOOL_WORKER_ID')
      let payload = isVitestWorkerOld
        ? { __tinypool_worker_message__: true, interprocessCode: this._interprocessCode, data: serialized }
        : [this._interprocessCode, serialized]
      if (this._isWebdriverioWorker) {
        payload = createWebdriverioWorkerMessage(payload)
      }

      const vitestWorkerPort = getVitestWorkerPort()
      if (vitestWorkerPort) {
        vitestWorkerPort.postMessage(payload)
      } else if (process.send) {
        process.send(payload, (error) => {
          if (error) log.error('Error sending message to test worker parent: %s', error)
          onDone(error)
        })
        return
      } else {
        const { parentPort } = require('node:worker_threads')
        parentPort?.postMessage(payload)
      }
    } catch (error) {
      log.error('Error sending message to test worker parent: %s', error)
      onDone(error)
      return
    }

    // postMessage has no acknowledgement callback. Completion means the
    // message was accepted by the local port, not processed by the parent.
    onDone()
  }
}

module.exports = Writer
