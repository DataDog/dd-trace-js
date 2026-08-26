'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')

const { describe, it } = require('mocha')

require('../../setup/core')

// Other exporter specs install HTTP interceptors while Mocha loads the suite, so
// capture the unmodified `http.request` before any patching.
const createRequest = http.request

const {
  httpAgent: commonHttpAgent,
  httpsAgent: commonHttpsAgent,
} = require('../../../src/exporters/common/agents')
const { getAgent, isOriginSaturated } = require('../../../src/ci-visibility/exporters/agents')

describe('Test Optimization exporter agents', () => {
  const httpAgent = getAgent('http://localhost')
  const httpsAgent = getAgent('https://localhost')

  it('keeps the shared exporter agents serialized at one socket', () => {
    assert.strictEqual(commonHttpAgent.keepAlive, true)
    assert.strictEqual(commonHttpAgent.maxSockets, 1)
    assert.strictEqual(commonHttpsAgent.keepAlive, true)
    assert.strictEqual(commonHttpsAgent.maxSockets, 1)
  })

  it('configures dedicated agents with bounded concurrency and keep-alive', () => {
    assert.strictEqual(httpAgent.keepAlive, true)
    assert.strictEqual(httpAgent.maxSockets, 8)
    assert.strictEqual(httpsAgent.keepAlive, true)
    assert.strictEqual(httpsAgent.maxSockets, 8)
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

  it('opens eight same-origin connections and queues the ninth', async () => {
    const agent = new httpAgent.constructor()
    const lookupCallbacks = []
    const lookup = (hostname, options, callback) => lookupCallbacks.push(callback)
    const requests = new Array(9)

    for (let index = 0; index < requests.length; index++) {
      const request = createRequest({ agent, hostname: 'test.local', lookup })
      request.on('error', () => {})
      request.end()
      requests[index] = request
    }

    await new Promise(resolve => setImmediate(resolve))

    try {
      assert.strictEqual(lookupCallbacks.length, 8)
      assert.deepStrictEqual(Object.values(agent.sockets).map(sockets => sockets.length), [8])
      assert.deepStrictEqual(Object.values(agent.requests).map(requests => requests.length), [1])
    } finally {
      for (const request of requests) request.destroy()
      agent.destroy()
    }
  })

  describe('isOriginSaturated', () => {
    it('is not saturated when the pool is idle', () => {
      const agent = new httpAgent.constructor()
      try {
        assert.strictEqual(isOriginSaturated('http://idle.example:8080', agent), false)
      } finally {
        agent.destroy()
      }
    })

    it('is saturated once eight same-origin requests are in flight', async () => {
      const agent = new httpAgent.constructor()
      const lookup = () => {} // never resolves, so requests stay in flight
      const requests = new Array(8)
      const url = 'http://saturated.example:8080'

      for (let index = 0; index < requests.length; index++) {
        const request = createRequest({ agent, hostname: 'saturated.example', port: 8080, lookup })
        request.on('error', () => {})
        request.end()
        requests[index] = request
      }

      await new Promise(resolve => setImmediate(resolve))

      try {
        assert.strictEqual(isOriginSaturated(url, agent), true)
      } finally {
        for (const request of requests) request.destroy()
        agent.destroy()
      }
    })

    it('detects saturation for a default-port URL that omits an explicit port', async () => {
      const agent = new httpsAgent.constructor()
      const lookup = () => {} // never resolves, so requests stay in flight
      const requests = new Array(8)
      const url = 'https://saturated.example' // no explicit port; Node normalizes to 443

      for (let index = 0; index < requests.length; index++) {
        const request = createRequest({
          agent,
          ...require('node:url').urlToHttpOptions(new URL(url)),
          lookup,
        })
        request.on('error', () => {})
        request.end()
        requests[index] = request
      }

      await new Promise(resolve => setImmediate(resolve))

      try {
        assert.strictEqual(isOriginSaturated(url, agent), true)
      } finally {
        for (const request of requests) request.destroy()
        agent.destroy()
      }
    })

    it('detects saturation for an IPv6 literal URL', async () => {
      const agent = new httpAgent.constructor()
      const lookup = () => {}
      const requests = new Array(8)
      const url = 'http://[::1]:8126' // Node keys the pool as ::1:8126:

      for (let index = 0; index < requests.length; index++) {
        const request = createRequest({
          agent,
          ...require('node:url').urlToHttpOptions(new URL(url)),
          lookup,
        })
        request.on('error', () => {})
        request.end()
        requests[index] = request
      }

      await new Promise(resolve => setImmediate(resolve))

      try {
        assert.strictEqual(isOriginSaturated(url, agent), true)
      } finally {
        for (const request of requests) request.destroy()
        agent.destroy()
      }
    })

    it('is saturated once a request is queued behind the active sockets', async () => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
      const lookup = () => {}
      const requests = new Array(2)
      const url = 'http://queued.example:8080'

      for (let index = 0; index < requests.length; index++) {
        const request = createRequest({ agent, hostname: 'queued.example', port: 8080, lookup })
        request.on('error', () => {})
        request.end()
        requests[index] = request
      }

      await new Promise(resolve => setImmediate(resolve))

      try {
        assert.strictEqual(isOriginSaturated(url, agent), true)
      } finally {
        for (const request of requests) request.destroy()
        agent.destroy()
      }
    })

    it('fails open for an unparseable URL', () => {
      assert.strictEqual(isOriginSaturated('not a url'), false)
    })
  })
})
