'use strict'

const assert = require('node:assert/strict')
const { fork, spawn } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const {
  parentPort,
  Worker,
  workerData,
} = require('node:worker_threads')

const { channel } = require('dc-polyfill')

const ROLE_ENV = 'DD_IDENTITY_PROPAGATION_ROLE'
const URL_ENV = 'DD_IDENTITY_PROPAGATION_URL'

/**
 * @typedef {{ error?: string, refreshCount?: number, role: string, type: string }} TestMessage
 */

const role = workerData?.role ?? process.env[ROLE_ENV]
const url = workerData?.url ?? process.env[URL_ENV]

if (role) {
  runDescendant(role, url).catch(reportError)
} else {
  runParent().catch(error => {
    process.stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  })
}

/**
 * @param {string} role
 * @param {string} url
 */
async function runDescendant (role, url) {
  const tracer = require('../..').init({
    appsec: false,
    plugins: false,
    profiling: false,
    remoteConfig: false,
    runtimeMetrics: false,
    runtimeMetricsRuntimeId: true,
    startupLogs: false,
    url,
  })

  let refreshCount = 0
  await flushMetric(tracer, role, 'before')

  async function onIdentityRefresh () {
    try {
      refreshCount++
      await flushMetric(tracer, role, 'after')
      sendToParent({ role, type: 'refreshed' })
    } catch (error) {
      reportError(error)
    }
  }

  channel('datadog:identity:refresh').subscribe(onIdentityRefresh)
  onParentControl(message => {
    if (message.type === 'status') {
      sendToParent({ refreshCount, role, type: 'status' })
    } else if (message.type === 'stop') {
      if (parentPort) parentPort.close()
      else process.disconnect()
    }
  })

  sendToParent({ role, type: 'ready' })
}

/**
 * @param {import('../../index')} tracer
 * @param {string} role
 * @param {'before' | 'after'} phase
 */
async function flushMetric (tracer, role, phase) {
  tracer.dogstatsd.gauge(`identity.${role}.${phase}`, 1)
  await new Promise((resolve, reject) => {
    tracer.dogstatsd.flush(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * @param {TestMessage} message
 */
function sendToParent (message) {
  if (parentPort) {
    parentPort.postMessage(message)
  } else {
    process.send?.(message)
  }
}

/**
 * @param {(message: { type: string }) => void} handler
 */
function onParentControl (handler) {
  if (parentPort) {
    parentPort.on('message', handler)
  } else {
    process.on('message', handler)
  }
}

/**
 * @param {unknown} error
 */
function reportError (error) {
  sendToParent({
    role,
    type: 'error',
    error: error instanceof Error ? error.stack : String(error),
  })
  process.exitCode = 1
}

async function runParent () {
  const metrics = []

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function onRequest (request, response) {
    if (request.url === '/dogstatsd/v2/proxy') {
      request.setEncoding('utf8')
      let body = ''
      for await (const chunk of request) {
        body += chunk
      }
      metrics.push(body)
    }
    response.end()
  }

  const server = http.createServer(onRequest)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`

  require('../..').init({
    appsec: false,
    plugins: false,
    profiling: false,
    remoteConfig: false,
    runtimeMetrics: false,
    runtimeMetricsRuntimeId: true,
    startupLogs: false,
    url,
  })

  const worker = new Worker(__filename, { workerData: { role: 'worker', url } })
  const workerReady = once(worker, 'message')

  const forked = fork(__filename, [], { env: descendantEnvironment('fork', url) })
  const forkReady = once(forked, 'message')

  const spawned = spawn(process.execPath, [__filename], {
    env: descendantEnvironment('spawn', url),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const spawnReady = once(spawned, 'message')

  const disconnected = fork(__filename, [], { env: descendantEnvironment('disconnected', url) })
  const disconnectedReady = once(disconnected, 'message')

  const sendFailure = fork(__filename, [], { env: descendantEnvironment('send-error', url) })
  const sendFailureReady = once(sendFailure, 'message')

  const noIpc = spawn(process.execPath, ['-e', ''])
  const noIpcExit = once(noIpc, 'exit')

  const readyMessages = await Promise.all([
    workerReady,
    forkReady,
    spawnReady,
    disconnectedReady,
    sendFailureReady,
  ])
  assertMessages(readyMessages, 'ready', ['worker', 'fork', 'spawn', 'disconnected', 'send-error'])
  await noIpcExit

  const disconnectedExit = once(disconnected, 'exit')
  disconnected.disconnect()
  await disconnectedExit

  const sendAfterRefresh = sendFailure.send.bind(sendFailure)
  sendFailure.send = failChildSend

  const expectsRefresh = process.env.AWS_LAMBDA_MICROVM_IMAGE_ARN !== undefined
  if (expectsRefresh) {
    const refreshedMessages = [
      once(worker, 'message'),
      once(forked, 'message'),
      once(spawned, 'message'),
    ]
    await post(address.port, '/aws/lambda-microvms/runtime/v1/run')
    assertMessages(await Promise.all(refreshedMessages), 'refreshed', ['worker', 'fork', 'spawn'])
  } else {
    await post(address.port, '/aws/lambda-microvms/runtime/v1/run')
  }

  await post(address.port, '/aws/lambda-microvms/runtime/v1/run')

  const postRefreshNoIpc = spawn(process.execPath, ['-e', ''])
  await once(postRefreshNoIpc, 'exit')

  const statusMessages = [
    once(worker, 'message'),
    once(forked, 'message'),
    once(spawned, 'message'),
  ]
  worker.postMessage({ type: 'status' })
  forked.send({ type: 'status' })
  spawned.send({ type: 'status' })

  const statuses = await Promise.all(statusMessages)
  assertMessages(statuses, 'status', ['worker', 'fork', 'spawn'])
  const refreshCounts = Object.fromEntries(statuses.map(([message]) => [message.role, message.refreshCount]))

  const forkExit = once(forked, 'exit')
  const spawnExit = once(spawned, 'exit')
  const sendFailureExit = once(sendFailure, 'exit')
  forked.send({ type: 'stop' })
  spawned.send({ type: 'stop' })
  sendAfterRefresh({ type: 'stop' })
  await Promise.all([worker.terminate(), forkExit, spawnExit, sendFailureExit])

  const serverClosed = once(server, 'close')
  server.close()
  await serverClosed

  process.stdout.write(JSON.stringify({ metrics, refreshCounts }))
}

/**
 * @param {string} role
 * @param {string} url
 */
function descendantEnvironment (role, url) {
  return {
    ...process.env,
    [ROLE_ENV]: role,
    [URL_ENV]: url,
  }
}

/**
 * @param {object} _message
 * @param {(error: Error) => void} callback
 */
function failChildSend (_message, callback) {
  callback(new Error('test send failure'))
  return false
}

/**
 * @param {Array<[TestMessage]>} messages
 * @param {string} type
 * @param {string[]} roles
 */
function assertMessages (messages, type, roles) {
  assert.deepStrictEqual(
    messages.map(([message]) => ({ role: message.role, type: message.type })).sort(compareRoles),
    roles.map(role => ({ role, type })).sort(compareRoles)
  )
}

/**
 * @param {{ role: string }} left
 * @param {{ role: string }} right
 */
function compareRoles (left, right) {
  return left.role.localeCompare(right.role)
}

/**
 * @param {number} port
 * @param {string} path
 */
async function post (port, path) {
  const request = http.request({ hostname: '127.0.0.1', method: 'POST', path, port })
  const responsePromise = once(request, 'response')
  request.end()

  const [response] = await responsePromise
  const end = once(response, 'end')
  response.resume()
  await end
}
