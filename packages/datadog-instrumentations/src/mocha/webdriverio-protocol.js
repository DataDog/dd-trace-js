'use strict'

const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../../dd-trace/src/ci-visibility/exporters/test-worker/webdriverio')

/**
 * Sends a message over WebdriverIO's worker IPC envelope.
 *
 * @param {object} message
 * @param {(error?: Error) => void} [onError]
 * @param {() => void} [onDone]
 * @returns {void}
 */
function sendWebdriverioWorkerMessage (message, onError, onDone) {
  if (!process.send || !process.connected) {
    onError?.()
    onDone?.()
    return
  }

  process.send(createWebdriverioWorkerMessage(message), (error) => {
    if (error) {
      onError?.(error)
    }
    onDone?.()
  })
}

module.exports = {
  CONFIGURATION_REQUEST: 'dd:test-optimization:webdriverio:configuration:request',
  CONFIGURATION_RESPONSE: 'dd:test-optimization:webdriverio:configuration:response',
  createWebdriverioWorkerMessage,
  sendWebdriverioWorkerMessage,
  SUITE_FINISH: 'dd:test-optimization:webdriverio:test-suite:finish',
  WORKER_READY: 'dd:test-optimization:webdriverio:worker:ready',
  WORKER_READY_RESPONSE: 'dd:test-optimization:webdriverio:worker:ready:response',
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
}
