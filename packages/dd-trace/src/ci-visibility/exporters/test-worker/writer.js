'use strict'

const { getEnvironmentVariable } = require('../../../config/helper')
const log = require('../../../log')
const ByteBatch = require('../../encode/byte-batch')
const { JSONEncoder } = require('../../encode/json-encoder')
const { encodeWorkerTrace } = require('../../encode/worker-traces')
const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
} = require('./webdriverio')

const TRACE_BATCH_TARGET_BYTES = 4 * 1024 * 1024

/** @typedef {import('../../encode/worker-traces').WorkerTraceItem} WorkerTraceItem */

function getVitestWorkerPort () {
  const port = globalThis.__vitest_worker__?.ctx?.port
  return typeof port?.postMessage === 'function' ? port : undefined
}

class Writer {
  /** @type {ByteBatch<WorkerTraceItem> | undefined} */
  #traceBatch
  #maxTraceBytes
  #traceFlush

  /**
   * @param {number | null} interprocessCode
   * @param {number} [maxPackedFrameBytes] JSON IPC frame budget for packing an individual trace.
   */
  constructor (interprocessCode, maxPackedFrameBytes) {
    // Code used to identify the type of payload being sent to the main process
    this._interprocessCode = interprocessCode
    this._isWebdriverioWorker = !!getEnvironmentVariable(WEBDRIVERIO_WORKER_ENV)
    if (maxPackedFrameBytes === undefined) {
      this._encoder = new JSONEncoder()
    } else {
      const largestEnvelope = this.#wrapPayload([], true)
      const envelopeBytes = Buffer.byteLength(JSON.stringify(largestEnvelope) + '\n') - 2
      this.#traceBatch = new ByteBatch(Math.min(maxPackedFrameBytes, TRACE_BATCH_TARGET_BYTES) - envelopeBytes)
      this.#maxTraceBytes = maxPackedFrameBytes - envelopeBytes - 2
    }
  }

  /**
   * @param {(error?: Error) => void} [onDone]
   */
  flush (onDone) {
    if (this.#traceBatch !== undefined) {
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

  /** @param {unknown} payload */
  append (payload) {
    const batch = this.#traceBatch
    if (batch === undefined) {
      this._encoder.encode(payload)
      return
    }
    try {
      const { data, bytes } = encodeWorkerTrace(payload, this.#maxTraceBytes)
      if (batch.append(data, bytes)) return
      if (batch.count() > 0) this.#sendTraceBatch(batch.take())
      if (!batch.append(data, bytes)) this.#sendTraceBatch([data])
    } catch (error) {
      log.error('Error encoding test worker trace: %s', error)
    }
  }

  /**
   * @param {(error?: Error) => void} [onDone]
   */
  #flushTraceBatches (onDone) {
    if (this.#traceBatch.count() > 0) {
      this.#sendTraceBatch(this.#traceBatch.take())
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
   * @param {WorkerTraceItem[]} traces
   */
  #sendTraceBatch (traces) {
    const traceFlush = this.#traceFlush ??= { pending: 0, error: undefined, onDone: undefined }
    traceFlush.pending++
    this._sendPayload(traces, (error) => {
      traceFlush.error ||= error
      if (--traceFlush.pending === 0) {
        traceFlush.onDone?.(traceFlush.error)
      }
    })
  }

  /**
   * @param {unknown} data
   * @param {boolean} [isVitestWorkerOld]
   */
  #wrapPayload (data, isVitestWorkerOld = !!getEnvironmentVariable('TINYPOOL_WORKER_ID')) {
    // Old because vitest@>=4 uses `DD_VITEST_WORKER` and reports arrays just like other frameworks
    // Before vitest@>=4, we need the `__tinypool_worker_message__` property, or tinypool will crash
    const payload = isVitestWorkerOld
      ? { __tinypool_worker_message__: true, interprocessCode: this._interprocessCode, data }
      : [this._interprocessCode, data]
    return this._isWebdriverioWorker ? createWebdriverioWorkerMessage(payload) : payload
  }

  _sendPayload (data, onDone = () => {}) {
    // ## Cucumber
    // This reports to the test's main process the same way test data is reported by Cucumber
    // See cucumber code:
    // https://github.com/cucumber/cucumber-js/blob/5ce371870b677fe3d1a14915dc535688946f734c/src/runtime/parallel/run_worker.ts#L13

    try {
      const payload = this.#wrapPayload(data)
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
