'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../../setup/core')

const request = require('../../../src/ci-visibility/requests/request')

describe('ci-visibility/requests/request', () => {
  let timeoutStub

  beforeEach(() => {
    // Collapse retry delays (5–7.5 s) to 0 ms so tests don't wait for real time,
    // while leaving small delays (res.setTimeout, 0-ms retries) unchanged.
    const realSetTimeout = setTimeout
    timeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn, delay, ...args) => {
      return realSetTimeout(fn, delay > 100 ? 0 : delay, ...args)
    })
  })

  afterEach(() => {
    timeoutStub.restore()
    nock.cleanAll()
  })

  describe('statusCode preservation across retries', () => {
    it('should preserve 429 status code when the retry fails with a network error', (done) => {
      // x-ratelimit-reset: '0' → reset is in the past → waitMs = max(0, 0 − Date.now()) = 0
      nock('http://localhost:8126')
        .post('/path')
        .reply(429, 'rate limited', { 'x-ratelimit-reset': '0' })
        .post('/path')
        .replyWithError({ code: 'ECONNRESET' })

      request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
        assert.ok(err)
        assert.strictEqual(statusCode, 429)
        done()
      })
    })

    it('should preserve 5xx status code when the retry fails with a network error', (done) => {
      nock('http://localhost:8126')
        .post('/path')
        .reply(503, 'service unavailable')
        .post('/path')
        .replyWithError({ code: 'ECONNRESET' })

      request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
        assert.ok(err)
        assert.strictEqual(statusCode, 503)
        done()
      })
    })
  })
})
