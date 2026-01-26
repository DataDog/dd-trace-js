'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../setup/core')
const { fetchAgentInfo, clearCache } = require('../../src/agent/info')

describe('agent/info', () => {
  const port = 8126
  const url = `http://127.0.0.1:${port}`

  describe('fetchAgentInfo', () => {
    afterEach(() => {
      clearCache()
    })

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

    describe('caching', () => {
      let clock

      beforeEach(() => {
        clearCache()
        clock = sinon.useFakeTimers({
          toFake: ['Date']
        })
      })

      afterEach(() => {
        clock.restore()
        clearCache()
      })

      it('should cache responses for 1 minute', (done) => {
        const agentInfo = { endpoints: ['/evp_proxy/v2'] }
        // Nock only expects one request - a second would fail the test
        const scope = nock(url)
          .get('/info')
          .reply(200, JSON.stringify(agentInfo))

        // First call - should make HTTP request
        fetchAgentInfo(new URL(url), (err, response) => {
          assert.strictEqual(err, null)
          assert.deepStrictEqual(response, agentInfo)
          assert.strictEqual(scope.isDone(), true)

          // Second call immediately after - should use cache (no HTTP request)
          fetchAgentInfo(new URL(url), (err, response) => {
            assert.strictEqual(err, null)
            assert.deepStrictEqual(response, agentInfo)
            done()
          })
        })
      })

      it('should make new request after cache expires', (done) => {
        const agentInfo1 = { endpoints: ['/evp_proxy/v2'] }
        const agentInfo2 = { endpoints: ['/evp_proxy/v3'] }

        const scope1 = nock(url)
          .get('/info')
          .reply(200, JSON.stringify(agentInfo1))

        // First call
        fetchAgentInfo(new URL(url), (err, response) => {
          assert.strictEqual(err, null)
          assert.deepStrictEqual(response, agentInfo1)
          assert.strictEqual(scope1.isDone(), true)

          // Advance time by 61 seconds (past 1 minute cache TTL)
          clock.tick(61_000)

          const scope2 = nock(url)
            .get('/info')
            .reply(200, JSON.stringify(agentInfo2))

          // Second call after expiry - should make new HTTP request
          fetchAgentInfo(new URL(url), (err, response) => {
            assert.strictEqual(err, null)
            assert.deepStrictEqual(response, agentInfo2)
            assert.strictEqual(scope2.isDone(), true)
            done()
          })
        })
      })

      it('should clear cache when URL changes', (done) => {
        const url2 = `http://127.0.0.1:${port + 1}`
        const agentInfo1 = { endpoints: ['/evp_proxy/v2'] }
        const agentInfo2 = { endpoints: ['/evp_proxy/v3'] }

        const scope1 = nock(url)
          .get('/info')
          .reply(200, JSON.stringify(agentInfo1))

        const scope2 = nock(url2)
          .get('/info')
          .reply(200, JSON.stringify(agentInfo2))

        // First URL
        fetchAgentInfo(new URL(url), (err, response) => {
          assert.strictEqual(err, null)
          assert.deepStrictEqual(response, agentInfo1)
          assert.strictEqual(scope1.isDone(), true)

          // Second URL - should clear old cache and make new request
          fetchAgentInfo(new URL(url2), (err, response) => {
            assert.strictEqual(err, null)
            assert.deepStrictEqual(response, agentInfo2)
            assert.strictEqual(scope2.isDone(), true)

            // First URL again - cache was cleared, so make new request
            const scope3 = nock(url)
              .get('/info')
              .reply(200, JSON.stringify(agentInfo1))

            fetchAgentInfo(new URL(url), (err, response) => {
              assert.strictEqual(err, null)
              assert.deepStrictEqual(response, agentInfo1)
              assert.strictEqual(scope3.isDone(), true)
              done()
            })
          })
        })
      })

      it('should still use cached result within 1 minute window', (done) => {
        const agentInfo = { endpoints: ['/evp_proxy/v2'] }
        // Nock only expects one request - subsequent calls would fail if not cached
        const scope = nock(url)
          .get('/info')
          .reply(200, JSON.stringify(agentInfo))

        // First call
        fetchAgentInfo(new URL(url), (err, response) => {
          assert.strictEqual(err, null)
          assert.deepStrictEqual(response, agentInfo)
          assert.strictEqual(scope.isDone(), true)

          // Advance time by 30 seconds (still within cache TTL)
          clock.tick(30_000)

          // Second call - should still use cache (no HTTP request)
          fetchAgentInfo(new URL(url), (err, response) => {
            assert.strictEqual(err, null)
            assert.deepStrictEqual(response, agentInfo)

            // Advance time by another 29 seconds (59 total, still within TTL)
            clock.tick(29_000)

            // Third call - should still use cache (no HTTP request)
            fetchAgentInfo(new URL(url), (err, response) => {
              assert.strictEqual(err, null)
              assert.deepStrictEqual(response, agentInfo)
              done()
            })
          })
        })
      })
    })
  })
})
