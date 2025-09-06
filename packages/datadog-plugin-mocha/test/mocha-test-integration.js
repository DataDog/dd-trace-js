'use strict'

const assert = require('node:assert')
const { describe, it } = require('mocha')

const http = require('node:http')

describe('mocha-test-integration-http', () => {
  it('can do integration http', (done) => {
    setTimeout(() => {
      const req = http.request('http://test:123', (res) => {
        assert.strictEqual(res.statusCode, 200)
        done()
      })
      req.end()
    }, 100)
  })
})
