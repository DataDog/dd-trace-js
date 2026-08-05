let nextRequestId = 0
let nodeTransport

/**
 * Requests permission from the Vitest main process to schedule EFD retries for one suite.
 *
 * @param {{
 *   browserCommand?: string,
 *   directory?: string,
 *   hasNewTest: boolean,
 *   logMarker?: string,
 *   requestCode: number,
 *   testSuite: string
 * }} options
 * @returns {Promise<boolean>}
 */
export async function requestEfdSuiteAdmission ({
  browserCommand,
  directory,
  hasNewTest,
  logMarker,
  requestCode,
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

  if (directory && logMarker) {
    return requestLegacyEfdSuiteAdmission({
      directory,
      hasNewTest,
      logMarker,
      testSuite,
    })
  }

  const transport = nodeTransport ||= await getNodeTransport()
  if (!transport || !directory) return false

  const { requestId, response } = await getAdmissionResponse(directory)
  const data = {
    hasNewTest,
    requestId,
    testSuite,
  }
  const message = transport.usesTinypoolProtocol
    ? {
        __tinypool_worker_message__: true,
        data,
        interprocessCode: requestCode,
      }
    : [requestCode, data]

  transport.postMessage(message)
  return response
}

/**
 * Sends an EFD admission request through the console-log RPC available in Vitest 3.
 *
 * @param {{ directory: string, hasNewTest: boolean, logMarker: string, testSuite: string }} options
 * @returns {Promise<boolean>}
 */
async function requestLegacyEfdSuiteAdmission ({ directory, hasNewTest, logMarker, testSuite }) {
  const rpc = globalThis.__vitest_worker__?.rpc
  if (typeof rpc?.onUserConsoleLog !== 'function') return false

  try {
    const { requestId, response } = await getAdmissionResponse(directory)
    const rpcResult = rpc.onUserConsoleLog({
      [logMarker]: true,
      content: '',
      hasNewTest,
      requestId,
      testSuite,
      time: Date.now(),
      type: 'stdout',
    })
    rpcResult?.catch?.(() => {})
    return response
  } catch {}
  return false
}

/**
 * Creates a unique response path and waits for the Vitest main process to acknowledge it.
 *
 * @param {string} directory
 * @returns {Promise<{ requestId: string, response: Promise<boolean> }>}
 */
async function getAdmissionResponse (directory) {
  const { threadId } = await import('node:worker_threads')
  const requestId = `${globalThis.process.pid}-${threadId}-${++nextRequestId}`
  const responsePath = `${directory}/${requestId}`
  const fs = await import('node:fs')
  const response = new Promise(resolve => {
    const watcher = fs.watch(directory, (_event, filename) => {
      if (String(filename) !== requestId) return

      fs.promises.readFile(responsePath, 'utf8').then(allowed => {
        clearTimeout(timeout)
        watcher.close()
        fs.promises.unlink(responsePath).catch(() => {})
        resolve(allowed === '1')
      }, () => {})
    })
    const timeout = setTimeout(() => {
      watcher.close()
      resolve(false)
    }, 5000)
    timeout.unref?.()
  })
  return { requestId, response }
}

/**
 * Returns the native transport exposed to the current Vitest Node.js worker.
 *
 * @returns {Promise<{
 *   postMessage: (message: unknown) => void,
 *   usesTinypoolProtocol: boolean
 * }|undefined>}
 */
async function getNodeTransport () {
  const vitestPort = globalThis.__vitest_worker__?.ctx?.port
  if (typeof vitestPort?.postMessage === 'function') {
    return {
      postMessage: vitestPort.postMessage.bind(vitestPort),
      usesTinypoolProtocol: false,
    }
  }

  if (typeof globalThis.process?.send === 'function') {
    return {
      postMessage: globalThis.process.send.bind(globalThis.process),
      usesTinypoolProtocol: !!globalThis.process.env.TINYPOOL_WORKER_ID,
    }
  }

  if (globalThis.process?.versions?.node) {
    const { isMainThread, parentPort } = await import('node:worker_threads')
    if (!isMainThread && parentPort) {
      return {
        postMessage: parentPort.postMessage.bind(parentPort),
        usesTinypoolProtocol: false,
      }
    }
  }
}
