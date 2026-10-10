'use strict'

const { clearTimeout, setTimeout } = require('node:timers')

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
const VIDEO_UPLOAD = 'dd:test-optimization:webdriverio:video:upload'
const VIDEO_UPLOAD_RESPONSE = 'dd:test-optimization:webdriverio:video:upload:response'
const VIDEO_UPLOAD_TIMEOUT_MS = 5 * FINAL_FLUSH_TIMEOUT + 5000

/**
 * Sends a message over WebdriverIO's worker IPC envelope.
 *
 * @param {object} message
 * @param {(error?: Error) => void} [onError]
 * @param {() => void} [onDone]
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

let mediaUploadRequestId = 0
const mediaUploadRequests = new Map()

/**
 * Removes shared media response listeners when there are no pending requests.
 *
 */
function removeMediaUploadListeners () {
  if (mediaUploadRequests.size !== 0) return

  process.off('message', onMediaUploadResponse)
  process.off('disconnect', onMediaUploadDisconnect)
}

/**
 * Completes one pending media upload request.
 *
 * @param {string} requestId
 * @param {Error} [error]
 */
function finishMediaUploadRequest (requestId, error) {
  const request = mediaUploadRequests.get(requestId)
  if (!request) return

  mediaUploadRequests.delete(requestId)
  clearTimeout(request.timeout)
  removeMediaUploadListeners()
  request.onDone(error)
}

/**
 * Dispatches one coordinator media response to its pending request.
 *
 * @param {object} message
 */
function onMediaUploadResponse (message) {
  if (message?.name !== SCREENSHOT_UPLOAD_RESPONSE && message?.name !== VIDEO_UPLOAD_RESPONSE) return

  const { error: errorMessage, requestId } = message.content || {}
  if (!requestId) return

  finishMediaUploadRequest(requestId, errorMessage ? new Error(errorMessage) : undefined)
}

/**
 * Fails every pending media upload after coordinator disconnect.
 *
 */
function onMediaUploadDisconnect () {
  for (const requestId of mediaUploadRequests.keys()) {
    finishMediaUploadRequest(
      requestId,
      new Error('WebdriverIO coordinator disconnected during media upload')
    )
  }
}

/**
 * Requests one media upload from the WebdriverIO coordinator.
 *
 * @param {object} content - Upload metadata
 * @param {'screenshot'|'video'} kind
 * @param {(error?: Error) => void} onDone - Upload completion callback
 */
function requestWebdriverioMediaUpload (content, kind, onDone) {
  const requestId = `${process.pid}-${++mediaUploadRequestId}`
  const timeout = setTimeout(() => {
    finishMediaUploadRequest(requestId, new Error(`WebdriverIO ${kind} upload timed out`))
  }, kind === 'video' ? VIDEO_UPLOAD_TIMEOUT_MS : SCREENSHOT_UPLOAD_TIMEOUT_MS)
  timeout.unref?.()
  if (mediaUploadRequests.size === 0) {
    process.on('message', onMediaUploadResponse)
    process.once('disconnect', onMediaUploadDisconnect)
  }
  mediaUploadRequests.set(requestId, { onDone, timeout })
  sendWebdriverioWorkerMessage({
    origin: 'datadog',
    name: kind === 'video' ? VIDEO_UPLOAD : SCREENSHOT_UPLOAD,
    content: { ...content, requestId },
  }, error => finishMediaUploadRequest(
    requestId,
    error || new Error(`WebdriverIO ${kind} upload IPC failed`)
  ))
}

/**
 * @param {object} content
 * @param {(error?: Error) => void} onDone
 */
function requestWebdriverioScreenshotUpload (content, onDone) {
  requestWebdriverioMediaUpload(content, 'screenshot', onDone)
}

/**
 * @param {object} content
 * @param {(error?: Error) => void} onDone
 */
function requestWebdriverioVideoUpload (content, onDone) {
  requestWebdriverioMediaUpload(content, 'video', onDone)
}

module.exports = {
  CONFIGURATION_REQUEST: 'dd:test-optimization:webdriverio:configuration:request',
  CONFIGURATION_RESPONSE: 'dd:test-optimization:webdriverio:configuration:response',
  createWebdriverioWorkerMessage,
  requestWebdriverioScreenshotUpload,
  requestWebdriverioVideoUpload,
  SCREENSHOT_UPLOAD,
  SCREENSHOT_UPLOAD_RESPONSE,
  SCREENSHOT_UPLOAD_TIMEOUT_MS,
  sendWebdriverioWorkerMessage,
  SUITE_FINISH: 'dd:test-optimization:webdriverio:test-suite:finish',
  WORKER_READY: 'dd:test-optimization:webdriverio:worker:ready',
  WORKER_READY_RESPONSE: 'dd:test-optimization:webdriverio:worker:ready:response',
  VIDEO_UPLOAD_FLUSH: 'dd:test-optimization:webdriverio:video:flush',
  VIDEO_UPLOAD,
  VIDEO_UPLOAD_RESPONSE,
  VIDEO_UPLOAD_TIMEOUT_MS,
  WEBDRIVERIO_WORKER_ENV,
  WEBDRIVERIO_WORKER_EVENT,
  WEBDRIVERIO_WORKER_ORIGIN,
}
