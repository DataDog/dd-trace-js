const ADMISSION_TIMEOUT_MS = 5000

let nextRequestId = 0
let nodeTransportPromise
const pendingAdmissionRequests = new Map()

/**
 * Requests permission from the Vitest main process to schedule EFD retries for one suite.
 *
 * @param {{
 *   browserCommand?: string,
 *   hasNewTest: boolean,
 *   requestCode: number,
 *   responseCode: number,
 *   testSuite: string
 * }} options
 * @returns {Promise<boolean>}
 */
export async function requestEfdSuiteAdmission ({
  browserCommand,
  hasNewTest,
  requestCode,
  responseCode,
  testSuite,
}) {
  const browserCommands = globalThis.__vitest_browser_runner__?.commands
  if (browserCommands) {
    return browserCommands.triggerCommand(
      browserCommand,
      [testSuite, hasNewTest],
      new Error('Could not determine whether Vitest EFD retries should run')
    )
  }

  nodeTransportPromise ||= getNodeTransport(responseCode)
  const transport = await nodeTransportPromise
  if (!transport) return false

  const requestId = ++nextRequestId
  const response = new Promise(resolve => {
    const timeout = setTimeout(() => finishAdmissionRequest(requestId, false), ADMISSION_TIMEOUT_MS)
    timeout.unref?.()
    pendingAdmissionRequests.set(requestId, { resolve, timeout })
  })

  try {
    transport.postMessage([requestCode, { hasNewTest, requestId, testSuite }])
  } catch {
    finishAdmissionRequest(requestId, false)
  }
  return response
}

/**
 * Resolves and removes one pending EFD admission request.
 *
 * @param {number} requestId
 * @param {boolean} allowed
 * @returns {void}
 */
function finishAdmissionRequest (requestId, allowed) {
  const request = pendingAdmissionRequests.get(requestId)
  if (!request) return

  clearTimeout(request.timeout)
  pendingAdmissionRequests.delete(requestId)
  request.resolve(allowed)
}

/**
 * Handles an EFD admission response from the Vitest main process.
 *
 * @param {unknown} message
 * @param {number} responseCode
 * @returns {void}
 */
function handleAdmissionResponse (message, responseCode) {
  if (!Array.isArray(message) || message[0] !== responseCode) return

  const { allowed, requestId } = message[1] || {}
  if (Number.isSafeInteger(requestId)) {
    finishAdmissionRequest(requestId, allowed === true)
  }
}

/**
 * Returns the direct process or thread transport used by Vitest 4 workers.
 *
 * @param {number} responseCode
 * @returns {Promise<{ postMessage: (message: unknown) => void }|undefined>}
 */
async function getNodeTransport (responseCode) {
  if (typeof globalThis.process?.send === 'function') {
    globalThis.process.on('message', message => handleAdmissionResponse(message, responseCode))
    return {
      postMessage: globalThis.process.send.bind(globalThis.process),
    }
  }

  if (globalThis.process?.versions?.node) {
    const { isMainThread, parentPort } = await import('node:worker_threads')
    if (!isMainThread && parentPort) {
      parentPort.on('message', message => handleAdmissionResponse(message, responseCode))
      return {
        postMessage: parentPort.postMessage.bind(parentPort),
      }
    }
  }
}
