'use strict'

const {
  createWebdriverioWorkerMessage,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
} = require('../../../dd-trace/src/ci-visibility/exporters/test-worker/webdriverio')
const { FINAL_FLUSH_TIMEOUT } = require('../../../dd-trace/src/ci-visibility/final-flush')

const SCREENSHOT_UPLOAD = 'dd:test-optimization:webdriverio:screenshot:upload'
const SCREENSHOT_UPLOAD_RESPONSE = 'dd:test-optimization:webdriverio:screenshot:upload:response'
const SCREENSHOT_UPLOAD_TIMEOUT_MS = FINAL_FLUSH_TIMEOUT + 5000

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

let screenshotUploadRequestId = 0

/**
 * Requests one screenshot upload from the WebdriverIO coordinator.
 *
 * @param {object} content - Screenshot upload metadata
 * @param {(error?: Error) => void} onDone - Upload completion callback
 * @returns {void}
 */
function requestWebdriverioScreenshotUpload (content, onDone) {
  const requestId = `${process.pid}-${++screenshotUploadRequestId}`
  let finished = false
  let timeout

  const finish = (error) => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    timeout = undefined
    process.off('message', onMessage)
    process.off('disconnect', onDisconnect)
    onDone(error)
  }
  const onDisconnect = () => finish(new Error('WebdriverIO coordinator disconnected during screenshot upload'))
  const onMessage = (message) => {
    if (message?.name !== SCREENSHOT_UPLOAD_RESPONSE || message.content?.requestId !== requestId) return

    const errorMessage = message.content.error
    finish(errorMessage ? new Error(errorMessage) : undefined)
  }

  process.on('message', onMessage)
  process.once('disconnect', onDisconnect)
  timeout = setTimeout(() => {
    finish(new Error('WebdriverIO screenshot upload timed out'))
  }, SCREENSHOT_UPLOAD_TIMEOUT_MS)
  timeout.unref?.()
  sendWebdriverioWorkerMessage({
    origin: 'datadog',
    name: SCREENSHOT_UPLOAD,
    content: { ...content, requestId },
  }, (error) => finish(error || new Error('WebdriverIO screenshot upload IPC failed')))
}

module.exports = {
  CONFIGURATION_REQUEST: 'dd:test-optimization:webdriverio:configuration:request',
  CONFIGURATION_RESPONSE: 'dd:test-optimization:webdriverio:configuration:response',
  createWebdriverioWorkerMessage,
  requestWebdriverioScreenshotUpload,
  SCREENSHOT_UPLOAD,
  SCREENSHOT_UPLOAD_RESPONSE,
  SCREENSHOT_UPLOAD_TIMEOUT_MS,
  sendWebdriverioWorkerMessage,
  SUITE_FINISH: 'dd:test-optimization:webdriverio:test-suite:finish',
  WORKER_READY: 'dd:test-optimization:webdriverio:worker:ready',
  WORKER_READY_RESPONSE: 'dd:test-optimization:webdriverio:worker:ready:response',
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
}
