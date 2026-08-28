'use strict'

const assert = require('node:assert/strict')
const http = require('http')
const net = require('net')

const { describe, it } = require('mocha')

require('../../setup/core')

const createRequest = http.request

const {
  httpAgent: commonHttpAgent,
  httpsAgent: commonHttpsAgent,
} = require('../../../src/exporters/common/agents')
const { getAgent } = require('../../../src/ci-visibility/exporters/agents')

describe('Test Optimization exporter agents', () => {
  const httpAgent = getAgent('http://localhost')
  const httpsAgent = getAgent('https://localhost')

  it('keeps the shared exporter agents serialized at one socket', () => {
    assert.notStrictEqual(httpAgent, commonHttpAgent)
    assert.notStrictEqual(httpsAgent, commonHttpsAgent)
    assert.strictEqual(commonHttpAgent.keepAlive, true)
    assert.strictEqual(commonHttpAgent.maxSockets, 1)
    assert.strictEqual(commonHttpsAgent.keepAlive, true)
    assert.strictEqual(commonHttpsAgent.maxSockets, 1)
  })

  it('configures dedicated agents with bounded concurrency and keep-alive', () => {
    assert.strictEqual(httpAgent.keepAlive, true)
    assert.strictEqual(httpAgent.maxSockets, 16)
    assert.strictEqual(httpsAgent.keepAlive, true)
    assert.strictEqual(httpsAgent.maxSockets, 16)
  })

  it('selects the agent by protocol for URL objects and strings', () => {
    assert.strictEqual(getAgent(new URL('http://localhost')), httpAgent)
    assert.strictEqual(getAgent('http://localhost'), httpAgent)
    assert.strictEqual(getAgent(new URL('https://localhost')), httpsAgent)
    assert.strictEqual(getAgent('https://localhost'), httpsAgent)
  })

  it('returns a stable singleton per protocol', () => {
    assert.strictEqual(getAgent('http://a.example'), getAgent('http://b.example'))
    assert.strictEqual(getAgent('https://a.example'), getAgent('https://b.example'))
  })

  it('manages the keep-alive socket lifecycle', () => {
    const socket = new net.Socket()
    const request = {}

    assert.strictEqual(httpAgent.keepSocketAlive(socket), true)
    httpAgent.reuseSocket(socket, request)
    assert.strictEqual(request.reusedSocket, true)
    socket.destroy()
  })

  it('opens sixteen same-origin connections and queues the seventeenth', async () => {
    const agent = new httpAgent.constructor()
    const lookupCallbacks = []
    const lookup = (hostname, options, callback) => lookupCallbacks.push(callback)
    const requests = new Array(17)

    for (let index = 0; index < requests.length; index++) {
      const request = createRequest({ agent, hostname: 'test.local', lookup })
      request.on('error', () => {})
      request.end()
      requests[index] = request
    }

    await new Promise(resolve => setImmediate(resolve))

    try {
      assert.strictEqual(lookupCallbacks.length, 16)
      assert.deepStrictEqual(Object.values(agent.sockets).map(sockets => sockets.length), [16])
      assert.deepStrictEqual(Object.values(agent.requests).map(requests => requests.length), [1])
    } finally {
      for (const request of requests) request.destroy()
      agent.destroy()
    }
  })
})
