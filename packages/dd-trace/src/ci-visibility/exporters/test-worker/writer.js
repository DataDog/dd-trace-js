'use strict'
const { getEnvironmentVariable } = require('../../../config/helper')
const log = require('../../../log')
const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
} = require('./webdriverio')

const TRACE_BATCH_TARGET_BYTES = 2 * 1024 * 1024

function getVitestWorkerPort () {
  const port = globalThis.__vitest_worker__?.ctx?.port
  return typeof port?.postMessage === 'function' ? port : undefined
}

/** @template {object} T */
class Writer {
  /** @type {object[]} */
  #payloads = []
  #batchBytes = 0
  #encodePayload
  #pendingFlushes = 0
  #flushCallbacks = []
  #flushError

  /**
   * @param {number | null} interprocessCode
   * @param {(payload: T) => { payload: object, bytes: number }} [encodePayload]
   */
  constructor (interprocessCode, encodePayload) {
    this.#encodePayload = encodePayload
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
    if (onDone) this.#flushCallbacks.push(onDone)

    if (this.#payloads.length > 0) {
      const payloads = this.#payloads
      this.#payloads = []
      this.#batchBytes = 0

      this.#pendingFlushes++
      this._sendPayload(payloads, error => {
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

  /** @param {T} payload */
  append (payload) {
    if (!this.#encodePayload) {
      this.#payloads.push(payload)
      return
    }

    let encoded
    try {
      encoded = this.#encodePayload(payload)
    } catch (error) {
      this.#flushError ||= error
      log.error('Error encoding test worker trace: %s', error)
      return
    }

    if (this.#payloads.length > 0 && this.#batchBytes + encoded.bytes > TRACE_BATCH_TARGET_BYTES) this.flush()
    this.#payloads.push(encoded.payload)
    this.#batchBytes += encoded.bytes
    // A trace is indivisible. Send it alone if it exceeds the target batch size.
    if (this.#batchBytes > TRACE_BATCH_TARGET_BYTES) this.flush()
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

    try {
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

    // postMessage completes when the port accepts the message.
    onDone()
  }
}

module.exports = Writer
