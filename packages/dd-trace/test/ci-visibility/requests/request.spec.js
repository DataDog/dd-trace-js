'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const https = require('node:https')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const { httpsAgent } = require('../../../src/exporters/common/agents')

describe('ci-visibility/requests/request', () => {
  let clock
  let getHttpsProxyAgent
  let request
  let timeoutStub

  beforeEach(() => {
    getHttpsProxyAgent = sinon.stub().callsFake((url, agent) => agent)
    request = proxyquire('../../../src/ci-visibility/requests/request', {
      '../../exporters/common/proxy': { getHttpsProxyAgent },
    })
    clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] })

    // Collapse retry delays (5–7.5 s) to 0 ms so tests don't wait for real time,
    // while leaving small delays (res.setTimeout, 0-ms retries) unchanged.
    const realSetTimeout = setTimeout
    timeoutStub = sinon.stub(global, 'setTimeout').callsFake((fn, delay, ...args) => {
      return realSetTimeout(fn, delay > 100 ? 0 : delay, ...args)
    })
  })

  it('selects an HTTPS proxy agent for authenticated requests', (done) => {
    const url = new URL('https://intake.example/path')
    const options = {
      url,
      headers: {
        'DD-API-KEY': 'test-api-key',
      },
    }
    nock('https://intake.example').post('/path').reply(200, 'ok')

    request('{}', options, (error) => {
      sinon.assert.calledOnceWithExactly(getHttpsProxyAgent, sinon.match({
        ...options,
        headers: sinon.match.object,
      }), httpsAgent)
      done(error)
    })
  })

  it('keeps HTTPS requests without an API key direct', (done) => {
    nock('https://intake.example').post('/path').reply(200, 'ok')

    request('{}', { url: 'https://intake.example/path' }, (error) => {
      sinon.assert.notCalled(getHttpsProxyAgent)
      done(error)
    })
  })

  it('reports proxy selection errors without starting a request', () => {
    const error = new Error('invalid proxy URL')
    const requestSpy = sinon.spy(https, 'request')
    const callback = sinon.spy()
    getHttpsProxyAgent.throws(error)

    request('{}', {
      url: 'https://intake.example/path',
      headers: {
        'DD-API-KEY': 'test-api-key',
      },
    }, callback)

    requestSpy.restore()
    sinon.assert.calledOnceWithExactly(callback, error)
    sinon.assert.notCalled(requestSpy)
  })

  afterEach(() => {
    timeoutStub.restore()
    clock.restore()
    nock.cleanAll()
  })

  describe('statusCode preservation across retries', () => {
    it('should preserve 429 status code when the retry fails with a network error', (done) => {
      const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

      // x-ratelimit-reset: '0' → reset is in the past → waitMs = max(0, 0 − Date.now()) = 0
      nock('http://localhost:8126')
        .post('/path')
        .reply(429, 'rate limited', { 'x-ratelimit-reset': '0' })
        .post('/path')
        .replyWithError(networkError)

      request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
        assert.ok(err)
        assert.strictEqual(statusCode, 429)
        done()
      })
    })

    it('should preserve 5xx status code when the retry fails with a network error', (done) => {
      const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

      nock('http://localhost:8126')
        .post('/path')
        .reply(503, 'service unavailable')
        .post('/path')
        .replyWithError(networkError)

      request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
        assert.ok(err)
        assert.strictEqual(statusCode, 503)
        done()
      })
    })
  })

  it('should retry on a transient network error and succeed on the next attempt', (done) => {
    const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

    nock('http://localhost:8126')
      .post('/path')
      .replyWithError(networkError)
      .post('/path')
      .reply(200, 'ok')

    request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
      assert.strictEqual(err, null)
      assert.strictEqual(res, 'ok')
      assert.strictEqual(statusCode, 200)
      done()
    })
  })

  it('treats X-RateLimit-Reset as a duration in seconds', (done) => {
    nock('http://localhost:8126')
      .post('/path')
      .reply(429, 'rate limited', { 'x-ratelimit-reset': '5' })
      .post('/path')
      .reply(200, 'ok')

    request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
      try {
        assert.strictEqual(err, null)
        assert.strictEqual(res, 'ok')
        assert.strictEqual(statusCode, 200)
        assert.strictEqual(timeoutStub.calledWith(sinon.match.func, 5000), true)
      } catch (error) {
        return done(error)
      }
      done()
    })
  })

  for (const { name, getHeaders, expectedDelay } of [
    {
      name: 'uses Retry-After delay seconds',
      getHeaders: () => ({ 'retry-after': '3', 'x-ratelimit-reset': '5' }),
      expectedDelay: 3000,
    },
    {
      name: 'supports Retry-After HTTP dates',
      getHeaders: () => ({ 'retry-after': new Date(Date.now() + 5000).toUTCString() }),
      expectedDelay: 5000,
    },
    {
      name: 'supports legacy absolute X-RateLimit-Reset timestamps',
      getHeaders: () => ({ 'x-ratelimit-reset': String(Date.now() / 1000 + 5) }),
      expectedDelay: 5000,
    },
  ]) {
    it(name, (done) => {
      nock('http://localhost:8126')
        .post('/path')
        .reply(429, 'rate limited', getHeaders())
        .post('/path')
        .reply(200, 'ok')

      request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
        try {
          assert.strictEqual(err, null)
          assert.strictEqual(res, 'ok')
          assert.strictEqual(statusCode, 200)
          assert.strictEqual(timeoutStub.calledWith(sinon.match.func, expectedDelay), true)
        } catch (error) {
          return done(error)
        }
        done()
      })
    })
  }

  it('falls back to X-RateLimit-Reset when Retry-After is negative', (done) => {
    nock('http://localhost:8126')
      .post('/path')
      .reply(429, 'rate limited', {
        'retry-after': '-1',
        'x-ratelimit-reset': '5',
      })
      .post('/path')
      .reply(200, 'ok')

    request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
      try {
        assert.strictEqual(err, null)
        assert.strictEqual(res, 'ok')
        assert.strictEqual(statusCode, 200)
        assert.strictEqual(timeoutStub.calledWith(sinon.match.func, 5000), true)
      } catch (error) {
        return done(error)
      }
      done()
    })
  })

  it('does not retry a negative X-RateLimit-Reset delay', (done) => {
    nock('http://localhost:8126')
      .post('/path')
      .reply(429, 'rate limited', { 'x-ratelimit-reset': '-1' })

    request('{}', { url: 'http://localhost:8126', path: '/path' }, (err, res, statusCode) => {
      try {
        assert.ok(err)
        assert.strictEqual(res, null)
        assert.strictEqual(statusCode, 429)
        assert.strictEqual(timeoutStub.called, false)
      } catch (error) {
        return done(error)
      }
      done()
    })
  })

  // A Windows named pipe URL object must reach http.request as a single
  // `//./pipe/<name>` socket path; the connection itself fails on the test host,
  // which is fine — we only pin the options the request was built with.
  it('derives the socket path for a Windows named pipe URL object', (done) => {
    const requestSpy = sinon.spy(http, 'request')

    request('{}', { url: new URL('unix://./pipe/datadog'), path: '/path' }, () => {
      requestSpy.restore()
      try {
        assert.ok(requestSpy.called)
        assert.strictEqual(requestSpy.getCall(0).args[0].socketPath, '//./pipe/datadog')
      } catch (error) {
        return done(error)
      }
      done()
    })
  })
})
