'use strict'

const CUCUMBER_WORKER_TRACE_PAYLOAD_CODE = 70
const delayCucumberWorkerMessagesMs = Number(process.env.DD_TEST_DELAY_CUCUMBER_WORKER_MESSAGES_MS) || 0
const dropEfdRetryCountMessages = process.env.DD_TEST_DROP_CUCUMBER_EFD_RETRY_COUNT_MESSAGES === '1'

/**
 * @param {unknown} message
 */
function isDdTraceWorkerTraceMessage (message) {
  return Array.isArray(message) && message[0] === CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
}

if (
  (delayCucumberWorkerMessagesMs > 0 || dropEfdRetryCountMessages) &&
  process.env.CUCUMBER_WORKER_ID &&
  process.send
) {
  const originalProcessSend = process.send

  /**
   * @param {...unknown} args
   */
  process.send = function (...args) {
    const [message] = args

    if (dropEfdRetryCountMessages && message?._ddEfdRetryCount) {
      return true
    }
    if (delayCucumberWorkerMessagesMs === 0 || isDdTraceWorkerTraceMessage(message)) {
      return originalProcessSend.apply(process, args)
    }

    global.setTimeout(() => {
      originalProcessSend.apply(process, args)
    }, delayCucumberWorkerMessagesMs)

    return true
  }
}

if (
  (delayCucumberWorkerMessagesMs > 0 || dropEfdRetryCountMessages) &&
  process.env.CUCUMBER_WORKER_ID
) {
  try {
    const { isMainThread, parentPort } = require('node:worker_threads')

    if (!isMainThread && parentPort) {
      const originalPostMessage = parentPort.postMessage

      /**
       * @param {...unknown} args
       */
      parentPort.postMessage = function (...args) {
        const [message] = args

        if (dropEfdRetryCountMessages && message?._ddEfdRetryCount) {
          return
        }
        if (delayCucumberWorkerMessagesMs === 0 || isDdTraceWorkerTraceMessage(message)) {
          return originalPostMessage.apply(parentPort, args)
        }

        global.setTimeout(() => {
          originalPostMessage.apply(parentPort, args)
        }, delayCucumberWorkerMessagesMs)
      }
    }
  } catch {
    // This fixture also runs on old Node versions where worker_threads may be unavailable.
  }
}
