'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const net = require('node:net')

const { describe, it } = require('mocha')

require('../../setup/core')

const {
  createAgent,
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
    assert.strictEqual(commonHttpAgent.maxSockets, 1)
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

  it('opens eight same-origin connections and queues the ninth', async () => {
    const testAgent = createAgent(http.Agent, { keepAlive: true, maxSockets: httpAgent.maxSockets })
    const requests = new Array(9)
    testAgent.createConnection = () => new net.Socket()

    for (let index = 0; index < requests.length; index++) {
      const request = new EventEmitter()
      request.getHeader = () => undefined
      request.onSocket = socket => { request.socket = socket }
      requests[index] = request
      testAgent.addRequest(request, { host: 'test.local', port: 80 })
    }

    await new Promise(resolve => setImmediate(resolve))

    try {
      const activeSockets = Object.values(testAgent.sockets)
      const queuedRequests = Object.values(testAgent.requests)

      assert.deepStrictEqual(activeSockets.map(sockets => sockets.length), [8])
      assert.deepStrictEqual(queuedRequests.map(requests => requests.length), [1])
    } finally {
      for (const request of requests) request.socket?.destroy()
      testAgent.destroy()
    }
  })
})
