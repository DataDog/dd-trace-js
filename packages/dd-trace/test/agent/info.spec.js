'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const nock = require('nock')

require('../setup/core')
const { fetchAgentInfo } = require('../../src/agent/info')

describe('agent/info', () => {
  const port = 8126
  const url = `http://127.0.0.1:${port}`

  describe('fetchAgentInfo', () => {
    it('should query /info endpoint and parse response', (done) => {
      const scope = nock(url)
        .get('/info')
        .reply(200, JSON.stringify({
          endpoints: ['/evp_proxy/v2']
        }))

      assert.notStrictEqual(scope.isDone(), true)
      fetchAgentInfo(new URL(url), (err, response) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(response.endpoints, ['/evp_proxy/v2'])
        assert.strictEqual(scope.isDone(), true)
        done()
      })
    })

    it('should handle error responses', (done) => {
      const scope = nock(url)
        .get('/info')
        .reply(500, 'Internal Server Error')

      fetchAgentInfo(new URL(url), (err, response) => {
        assert.ok(err)
        assert.strictEqual(response, undefined)
        assert.strictEqual(scope.isDone(), true)
        done()
      })
    })

    it('should handle invalid JSON responses', (done) => {
      const scope = nock(url)
        .get('/info')
        .reply(200, 'invalid json')

      fetchAgentInfo(new URL(url), (err, response) => {
        assert.ok(err)
        assert.ok(err instanceof SyntaxError)
        assert.strictEqual(response, undefined)
        assert.strictEqual(scope.isDone(), true)
        done()
      })
    })
  })
})
