'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')

const { describe, it } = require('mocha')

require('../../setup/core')

const { getAgent, httpAgent, httpsAgent } = require('../../../src/ci-visibility/exporters/agents')

describe('Test Optimization exporter agents', () => {
  it('configures dedicated agents with concurrent sockets', () => {
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

  it('opens concurrent connections to the same origin', async () => {
    const lookupCallbacks = []
    const lookup = (hostname, options, callback) => lookupCallbacks.push(callback)
    const requests = [
      http.request({ agent: httpAgent, hostname: 'test.local', lookup }),
      http.request({ agent: httpAgent, hostname: 'test.local', lookup }),
    ]
    for (const request of requests) {
      request.on('error', () => {})
      request.end()
    }

    await new Promise(resolve => setImmediate(resolve))
    try {
      assert.strictEqual(lookupCallbacks.length, 2)
    } finally {
      for (const request of requests) request.destroy()
    }
  })
})
