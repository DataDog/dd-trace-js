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
const screenshotUploadRequests = new Map()

/**
 * Removes shared screenshot response listeners when there are no pending requests.
 *
 * @returns {void}
 */
function removeScreenshotUploadListeners () {
  if (screenshotUploadRequests.size !== 0) return

  process.off('message', onScreenshotUploadResponse)
  process.off('disconnect', onScreenshotUploadDisconnect)
}

/**
 * Completes one pending screenshot upload request.
 *
 * @param {string} requestId
 * @param {Error} [error]
 * @returns {void}
 */
function finishScreenshotUploadRequest (requestId, error) {
  const request = screenshotUploadRequests.get(requestId)
  if (!request) return

  screenshotUploadRequests.delete(requestId)
  clearTimeout(request.timeout)
  removeScreenshotUploadListeners()
  request.onDone(error)
}

/**
 * Dispatches one coordinator screenshot response to its pending request.
 *
 * @param {object} message
 * @returns {void}
 */
function onScreenshotUploadResponse (message) {
  if (message?.name !== SCREENSHOT_UPLOAD_RESPONSE) return

  const { error: errorMessage, requestId } = message.content || {}
  if (!requestId) return

  finishScreenshotUploadRequest(requestId, errorMessage ? new Error(errorMessage) : undefined)
}

/**
 * Fails every pending screenshot upload after coordinator disconnect.
 *
 * @returns {void}
 */
function onScreenshotUploadDisconnect () {
  for (const requestId of screenshotUploadRequests.keys()) {
    finishScreenshotUploadRequest(
      requestId,
      new Error('WebdriverIO coordinator disconnected during screenshot upload')
    )
  }
}

/**
 * Requests one screenshot upload from the WebdriverIO coordinator.
 *
 * @param {object} content - Screenshot upload metadata
 * @param {(error?: Error) => void} onDone - Upload completion callback
 * @returns {void}
 */
function requestWebdriverioScreenshotUpload (content, onDone) {
  const requestId = `${process.pid}-${++screenshotUploadRequestId}`
  const timeout = setTimeout(() => {
    finishScreenshotUploadRequest(requestId, new Error('WebdriverIO screenshot upload timed out'))
  }, SCREENSHOT_UPLOAD_TIMEOUT_MS)
  timeout.unref?.()
  if (screenshotUploadRequests.size === 0) {
    process.on('message', onScreenshotUploadResponse)
    process.once('disconnect', onScreenshotUploadDisconnect)
  }
  screenshotUploadRequests.set(requestId, { onDone, timeout })
  sendWebdriverioWorkerMessage({
    origin: 'datadog',
    name: SCREENSHOT_UPLOAD,
    content: { ...content, requestId },
  }, error => finishScreenshotUploadRequest(
    requestId,
    error || new Error('WebdriverIO screenshot upload IPC failed')
  ))
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
