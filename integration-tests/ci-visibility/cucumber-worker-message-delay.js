'use strict'

const CUCUMBER_WORKER_TRACE_PAYLOAD_CODE = 70
const delayCucumberWorkerMessagesMs = Number(process.env.DD_TEST_DELAY_CUCUMBER_WORKER_MESSAGES_MS) || 0

function isDdTraceWorkerTraceMessage (message) {
  return Array.isArray(message) && message[0] === CUCUMBER_WORKER_TRACE_PAYLOAD_CODE
}

if (delayCucumberWorkerMessagesMs > 0 && process.env.CUCUMBER_WORKER_ID && process.send) {
  const originalProcessSend = process.send

  process.send = function (...args) {
    const [message] = args

    if (isDdTraceWorkerTraceMessage(message)) {
      return originalProcessSend.apply(process, args)
    }

    global.setTimeout(() => {
      originalProcessSend.apply(process, args)
    }, delayCucumberWorkerMessagesMs)

    return true
  }
}

if (delayCucumberWorkerMessagesMs > 0 && process.env.CUCUMBER_WORKER_ID) {
  try {
    const { isMainThread, parentPort } = require('node:worker_threads')

    if (!isMainThread && parentPort) {
      const originalPostMessage = parentPort.postMessage

      parentPort.postMessage = function (...args) {
        const [message] = args

        if (isDdTraceWorkerTraceMessage(message)) {
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
