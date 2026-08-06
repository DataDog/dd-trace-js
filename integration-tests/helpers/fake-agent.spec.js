'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const msgpack = require('@msgpack/msgpack')
const { afterEach, beforeEach, describe, it } = require('mocha')

const FakeAgent = require('./fake-agent')

describe('FakeAgent', () => {
  let agent

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(() => agent.stop())

  for (const method of ['PUT', 'POST']) {
    it(`accepts ${method} trace requests`, async () => {
      const message = once(agent, 'message')
      const body = msgpack.encode([[{ resource: `fixture.${method.toLowerCase()}` }]])
      const response = await postTrace(agent.port, method, body)

      assert.strictEqual(response.statusCode, 200)
      const [{ payload }] = await message
      assert.strictEqual(payload[0][0].resource, `fixture.${method.toLowerCase()}`)
    })
  }
})

/**
 * @param {number} port
 * @param {string} method
 * @param {Uint8Array} body
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function postTrace (port, method, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v0.4/traces',
      method,
      headers: {
        'content-length': body.byteLength,
        'content-type': 'application/msgpack',
      },
    }, (response) => {
      response.resume()
      response.on('end', () => resolve(response))
    })
    request.on('error', reject)
    request.end(body)
  })
}
