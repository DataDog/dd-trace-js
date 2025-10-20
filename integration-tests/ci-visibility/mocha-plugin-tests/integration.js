'use strict'

const assert = require('node:assert')
const http = require('node:http')

const ENDPOINT_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL ||
  `http://127.0.0.1:${process.env.DD_TRACE_AGENT_PORT}`

describe('mocha-test-integration-http', () => {
  it('can do integration http', (done) => {
    setTimeout(() => {
      const req = http.request(`${ENDPOINT_URL}/info`, { agent: false }, (res) => {
        assert.strictEqual(res.statusCode, 200)
        done()
      })
      req.end()
    }, 100)
  })
})
