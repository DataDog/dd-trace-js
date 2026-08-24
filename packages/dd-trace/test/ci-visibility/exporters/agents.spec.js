'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')

const { describe, it } = require('mocha')

require('../../setup/core')

// Other exporter specs install HTTP interceptors while Mocha loads the suite.
const createRequest = http.request

const {
  httpAgent: commonHttpAgent,
  httpsAgent: commonHttpsAgent,
} = require('../../../src/exporters/common/agents')
const {
  getAgent,
  httpAgent,
  httpsAgent,
} = require('../../../src/ci-visibility/exporters/agents')

describe('Test Optimization exporter agents', () => {
  it('keeps the common exporter agents serialized', () => {
    assert.strictEqual(commonHttpAgent.keepAlive, true)
    assert.strictEqual(commonHttpAgent.maxSockets, 1)
    assert.strictEqual(commonHttpsAgent.keepAlive, true)
    assert.strictEqual(commonHttpsAgent.maxSockets, 1)
  })

  it('configures dedicated agents with bounded concurrency', () => {
    assert.strictEqual(httpAgent.keepAlive, true)
    assert.strictEqual(httpAgent.maxSockets, 8)
    assert.strictEqual(httpsAgent.keepAlive, true)
    assert.strictEqual(httpsAgent.maxSockets, 8)
  })

  it('selects the agent for URL objects and strings', () => {
    assert.strictEqual(getAgent(new URL('http://localhost')), httpAgent)
    assert.strictEqual(getAgent('http://localhost'), httpAgent)
    assert.strictEqual(getAgent(new URL('https://localhost')), httpsAgent)
    assert.strictEqual(getAgent('https://localhost'), httpsAgent)
  })

  it('manages the keep-alive socket lifecycle', () => {
    const socket = new net.Socket()
    const request = {}

    assert.strictEqual(httpAgent.keepSocketAlive(socket), true)
    httpAgent.reuseSocket(socket, request)
    assert.strictEqual(request.reusedSocket, true)
    socket.destroy()
  })

  it('opens eight same-origin connections and queues the ninth', async () => {
    const testAgent = new httpAgent.constructor()
    const lookupCallbacks = []
    const lookup = (hostname, options, callback) => lookupCallbacks.push(callback)
    const requests = new Array(9)

    for (let index = 0; index < requests.length; index++) {
      const request = createRequest({ agent: testAgent, hostname: 'test.local', lookup })
      request.on('error', () => {})
      request.end()
      requests[index] = request
    }

    await new Promise(resolve => setImmediate(resolve))

    try {
      const activeSockets = Object.values(testAgent.sockets)
      const queuedRequests = Object.values(testAgent.requests)

      assert.strictEqual(lookupCallbacks.length, 8)
      assert.deepStrictEqual(activeSockets.map(sockets => sockets.length), [8])
      assert.deepStrictEqual(queuedRequests.map(requests => requests.length), [1])
    } finally {
      for (const request of requests) request.destroy()
      testAgent.destroy()
    }
  })
})
