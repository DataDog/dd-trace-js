'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const http = require('node:http')
const zlib = require('node:zlib')
const stream = require('node:stream')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const nock = require('nock')
const proxyquire = require('proxyquire')

require('../../setup/core')
const FormData = require('../../../src/exporters/common/form-data')

const initHTTPServer = () => {
  return new Promise(resolve => {
    const sockets = []
    const requestListener = function (req, res) {
      setTimeout(() => {
        res.writeHead(200)
        res.end('OK')
      }, 1000)
    }

    const server = http.createServer(requestListener)

    server.on('connection', socket => sockets.push(socket))

    server.listen(0, () => {
      const shutdown = () => {
        sockets.forEach(socket => socket.end())
        server.close()
      }
      shutdown.port = (/** @type {import('net').AddressInfo} */ (server.address())).port
      resolve(shutdown)
    })
  })
}

/**
 * Holds Nock responses until the test explicitly releases them.
 *
 * @param {number} requestCount
 * @returns {{
 *   release: (index: number) => void,
 *   scope: import('nock').Scope,
 *   waitForRequests: (expectedCount: number) => Promise<void>
 * }}
 */
function interceptControlledRequests (requestCount) {
  const responseCallbacks = []
  let waiter
  const scope = nock('http://test:123')
    .put('/path')
    .times(requestCount)
    .reply((uri, requestBody, callback) => {
      responseCallbacks.push(callback)
      if (waiter && responseCallbacks.length >= waiter.expectedCount) {
        const { resolve } = waiter
        waiter = undefined
        resolve()
      }
    })

  return {
    release: index => responseCallbacks[index](null, [200, 'OK']),
    scope,
    waitForRequests (expectedCount) {
      if (responseCallbacks.length >= expectedCount) return Promise.resolve()
      return new Promise(resolve => { waiter = { expectedCount, resolve } })
    },
  }
}

describe('request', function () {
  let request
  let log
  let docker
  let maxAttempts
  let retryStubs
  let runInNoopContext

  /**
   * Starts requests that occupy the shared active request buffer.
   *
   * @param {Buffer} data
   * @param {number} count
   * @returns {Promise<void>[]}
   */
  function startRequests (data, count) {
    const requests = []
    for (let index = 0; index < count; index++) {
      requests.push(new Promise((resolve, reject) => {
        request(data, {
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {},
        }, error => error ? reject(error) : resolve())
      }))
    }
    return requests
  }

  beforeEach(() => {
    log = {
      error: sinon.spy(),
      debug: sinon.spy(),
    }
    docker = {
      inject (carrier) {
        carrier['datadog-container-id'] = 'abcd'
      },
    }
    // The retry policy is exercised in retry.spec.js. Here we keep the integration
    // deterministic: zero backoff, no startup-phase mutation, attempt count
    // overridable per test.
    maxAttempts = 2
    retryStubs = {
      getRateLimitResetDelay: sinon.stub().returns(NaN),
      getRetryDelay: sinon.stub().returns(0),
      getMaxAttempts: sinon.fake(() => maxAttempts),
      markEndpointReached: sinon.fake(),
    }
    runInNoopContext = sinon.spy((_store, callback) => callback())
    request = proxyquire('../../../src/exporters/common/request', {
      '../../../../datadog-core': {
        storage: () => ({ run: runInNoopContext }),
      },
      './docker': docker,
      '../../log': log,
      './retry': {
        ...require('../../../src/exporters/common/retry'),
        ...retryStubs,
      },
    })
  })

  afterEach(() => {
    nock.cleanAll()
  })

  it('should send an http request with a buffer', (done) => {
    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': '13',
      },
    })
      .put('/path')
      .reply(200, 'OK')

    request(
      Buffer.from(JSON.stringify({ foo: 'bar' })), {
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      },
      (err, res) => {
        assert.strictEqual(res, 'OK')
        done(err)
      })
  })

  it('does not retry when retries are disabled', (done) => {
    maxAttempts = 5
    const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

    nock('http://localhost:80')
      .get('/path')
      .replyWithError(error)

    request(Buffer.from(''), {
      path: '/path',
      method: 'GET',
      retry: false,
    }, (requestError) => {
      assert.strictEqual(requestError, error)
      sinon.assert.notCalled(retryStubs.getMaxAttempts)
      sinon.assert.notCalled(retryStubs.getRetryDelay)
      done()
    })
  })

  it('allows callers to cancel a request with an AbortSignal', async () => {
    nock('http://localhost:80')
      .get('/path')
      .delayConnection(1000)
      .reply(200, 'OK')

    const abortController = new AbortController()
    /**
     * @param {() => void} resolve
     * @param {(error: Error) => void} reject
     */
    const execute = (resolve, reject) => {
      /** @param {Error | null} error */
      const onResponse = (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      request(Buffer.from(''), {
        path: '/path',
        method: 'GET',
        retry: false,
        signal: abortController.signal,
      }, onResponse)
    }
    const completed = new Promise(execute)

    abortController.abort()

    await assert.rejects(completed, { code: 'ABORT_ERR' })
  })

  it('does not start a request when its AbortSignal is already aborted', (done) => {
    const abortController = new AbortController()
    const error = new Error('final flush expired')
    error.code = 'ERR_DD_TEST_OPTIMIZATION_FLUSH_TIMEOUT'
    abortController.abort(error)

    request(Buffer.from(''), {
      method: 'GET',
      path: '/path',
      signal: abortController.signal,
    }, (requestError) => {
      assert.strictEqual(requestError, error)
      done()
    })
  })

  it('does not buffer a readable body when its AbortSignal is already aborted', () => {
    const abortController = new AbortController()
    const error = new Error('final flush expired')
    const body = new stream.PassThrough()
    const callback = sinon.spy()
    abortController.abort(error)

    request(body, {
      method: 'PUT',
      path: '/path',
      signal: abortController.signal,
    }, callback)

    sinon.assert.calledOnceWithExactly(callback, error)
    assert.strictEqual(body.listenerCount('data'), 0)
    assert.strictEqual(body.listenerCount('end'), 0)
    assert.strictEqual(body.listenerCount('error'), 0)
  })

  it('stops buffering a readable body when its AbortSignal aborts', async () => {
    const abortController = new AbortController()
    const error = new Error('final flush expired')
    const body = new stream.PassThrough()
    const callback = sinon.spy()

    request(body, {
      method: 'PUT',
      path: '/path',
      signal: abortController.signal,
    }, callback)
    body.write('partial body')
    const closed = new Promise(resolve => body.once('close', resolve))
    abortController.abort(error)
    await closed

    sinon.assert.calledOnceWithExactly(callback, error)
    assert.strictEqual(body.destroyed, true)
    assert.strictEqual(body.listenerCount('data'), 0)
    assert.strictEqual(body.listenerCount('end'), 0)
    assert.strictEqual(body.listenerCount('error'), 0)
  })

  it('absorbs an asynchronous readable destruction error after abort', async () => {
    const abortController = new AbortController()
    const abortError = new Error('final flush expired')
    const destroyError = new Error('body destruction failed')
    const callback = sinon.spy()
    const body = new stream.Readable({
      read () {},
      destroy (error, onDone) {
        setImmediate(onDone, destroyError)
      },
    })
    const closed = new Promise(resolve => body.once('close', resolve))

    request(body, {
      method: 'PUT',
      path: '/path',
      signal: abortController.signal,
    }, callback)
    abortController.abort(abortError)
    await closed

    sinon.assert.calledOnceWithExactly(callback, abortError)
    assert.strictEqual(body.listenerCount('error'), 0)
  })

  it('preserves errors from a readable body while buffering it', () => {
    const error = new Error('body stream failed')
    const body = new stream.PassThrough()
    const callback = sinon.spy()

    request(body, {
      method: 'PUT',
      path: '/path',
    }, callback)
    body.emit('error', error)

    sinon.assert.calledOnceWithExactly(callback, error)
    assert.strictEqual(body.listenerCount('data'), 0)
    assert.strictEqual(body.listenerCount('end'), 0)
    assert.strictEqual(body.listenerCount('error'), 0)
  })

  it('settles once when a response is truncated', async () => {
    /**
     * @param {import('node:http').IncomingMessage} incoming
     * @param {import('node:http').ServerResponse} response
     */
    const truncate = (incoming, response) => {
      incoming.resume()
      response.writeHead(200)
      response.write('partial')
      setImmediate(() => response.destroy())
    }
    const server = http.createServer(truncate)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')

    let callbacks = 0
    /**
     * @param {(error: Error | null) => void} resolve
     */
    const execute = (resolve) => {
      /** @param {Error | null} error */
      const onResponse = (error) => {
        callbacks++
        resolve(error)
      }
      request('', {
        method: 'GET',
        retry: false,
        url: new URL(`http://127.0.0.1:${server.address().port}`),
      }, onResponse)
    }

    try {
      const error = await new Promise(execute)
      assert.strictEqual(error.code, 'ECONNRESET')
      assert.strictEqual(callbacks, 1)
    } finally {
      const closed = once(server, 'close')
      server.close()
      await closed
    }
  })

  it('settles once when a response times out', async () => {
    const response = new EventEmitter()
    response.headers = {}
    response.statusCode = 200
    response.setTimeout = sinon.spy()
    /** @param {Error} error */
    response.destroy = (error) => {
      response.emit('error', error)
      response.emit('end')
    }

    let respond
    const requestMessage = new EventEmitter()
    requestMessage.abort = sinon.spy()
    requestMessage.setTimeout = sinon.spy()
    requestMessage.write = sinon.spy()
    requestMessage.end = () => {
      respond(response)
      response.emit('timeout')
    }

    /**
     * @param {object} options
     * @param {(response: EventEmitter) => void} onResponse
     */
    const createRequest = (options, onResponse) => {
      assert.strictEqual(options.method, 'GET')
      respond = onResponse
      return requestMessage
    }
    const timeoutRequest = proxyquire('../../../src/exporters/common/request', {
      '../../../../datadog-core': {
        storage: () => ({ run: runInNoopContext }),
      },
      http: { ...http, request: createRequest },
      './docker': docker,
      '../../log': log,
      './retry': {
        ...require('../../../src/exporters/common/retry'),
        ...retryStubs,
      },
    })

    let callbacks = 0
    /**
     * @param {(error: Error | null) => void} resolve
     */
    const execute = (resolve) => {
      /** @param {Error | null} error */
      const onResponse = (error) => {
        callbacks++
        resolve(error)
      }
      timeoutRequest('', { method: 'GET', retry: false }, onResponse)
    }

    const error = await new Promise(execute)
    assert.strictEqual(error.code, 'ETIMEDOUT')
    assert.strictEqual(callbacks, 1)
  })

  it('should handle an http error', done => {
    nock('http://localhost:8080')
      .put('/path')
      .reply(400)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      port: 8080,
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'Error from http://localhost:8080/path: 400 Bad Request.')
      done()
    })
  })

  it('should handle an http error when url is specified', done => {
    nock('http://api.datadog.com')
      .put('/path')
      .reply(400)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      url: new URL('http://api.datadog.com/'),
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'Error from http://api.datadog.com/path: 400 Bad Request.')
      done()
    })
  })

  // Live timeout → abort → retry → 'socket hang up' is covered by
  // `should have a configurable timeout` below at timeout: 100. Here we only
  // need to pin the default constant, which is faster and avoids waiting
  // for a real timer.
  it('defaults the request timeout to 2 seconds', (done) => {
    const sandbox = sinon.createSandbox()
    const realRequest = http.request
    let observedTimeout
    sandbox.replace(http, 'request', function (...args) {
      const req = realRequest.apply(this, args)
      const originalSetTimeout = req.setTimeout
      req.setTimeout = function (timeout, callback) {
        observedTimeout = timeout
        return originalSetTimeout.call(this, timeout, callback)
      }
      return req
    })

    nock('http://localhost:80').put('/path').reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err) => {
      sandbox.restore()
      assert.strictEqual(observedTimeout, 2000)
      done(err)
    })
  })

  it('should have a configurable timeout', done => {
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(101)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 100,
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'socket hang up')
      done()
    })
  })

  it('should inject the container ID', () => {
    nock('http://test:123', {
      reqheaders: {
        'datadog-container-id': 'abcd',
      },
    })
      .get('/')
      .reply(200, 'OK')

    return request(Buffer.from(''), {
      hostname: 'test',
      port: 123,
      path: '/',
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
    })
  })

  it('should retry', (done) => {
    const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done()
    })
  })

  it('should retry transient HTTP errors when requested', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(500)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      retryOnHttpError: true,
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done(err)
    })
  })

  it('should retry HTTP 429 responses when requested', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(429)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      retryOnHttpError: true,
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done(err)
    })
  })

  it('waits for a rate-limit reset that is inside the final flush deadline', (done) => {
    retryStubs.getRateLimitResetDelay.returns(999)
    const realSetTimeout = setTimeout
    const retryTimer = { unref: sinon.spy() }
    const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((callback, delay, ...args) => {
      if (delay !== 999) return realSetTimeout(callback, delay, ...args)
      queueMicrotask(() => callback(...args))
      return retryTimer
    })

    nock('http://localhost:80')
      .put('/path')
      .reply(429, '', { 'x-ratelimit-reset': 'reset timestamp' })
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      deadline: Date.now() + 2000,
      retryOnHttpError: true,
    }, (err, res) => {
      setTimeoutStub.restore()
      assert.strictEqual(res, 'OK')
      sinon.assert.calledOnceWithExactly(retryStubs.getRateLimitResetDelay, {
        'x-ratelimit-reset': 'reset timestamp',
      })
      sinon.assert.notCalled(retryStubs.getRetryDelay)
      sinon.assert.calledOnce(retryTimer.unref)
      done(err)
    })
  })

  it('does not retry a rate-limit reset at the final flush deadline', (done) => {
    retryStubs.getRateLimitResetDelay.returns(1000)

    nock('http://localhost:80')
      .put('/path')
      .reply(429, '', { 'x-ratelimit-reset': 'reset timestamp' })

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      deadline: Date.now() + 1000,
      retryOnHttpError: true,
    }, (err, res, statusCode) => {
      assert.strictEqual(err.status, 429)
      assert.strictEqual(res, null)
      assert.strictEqual(statusCode, 429)
      sinon.assert.notCalled(retryStubs.getRetryDelay)
      done()
    })
  })

  it('shortens an ordinary retry delay to fit the remaining final flush budget', (done) => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    retryStubs.getRetryDelay.returns(5000)
    const realSetTimeout = setTimeout
    const retryTimer = { unref: sinon.spy() }
    const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((callback, delay, ...args) => {
      if (delay !== 1000) return realSetTimeout(callback, delay, ...args)
      queueMicrotask(() => callback(...args))
      return retryTimer
    })

    nock('http://localhost:80')
      .put('/path')
      .reply(() => {
        clock.tick(7000)
        return [500]
      })
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      deadline: Date.now() + 10_000,
      retryOnHttpError: true,
    }, (err, res) => {
      setTimeoutStub.restore()
      clock.restore()
      assert.strictEqual(res, 'OK')
      sinon.assert.calledOnce(retryStubs.getRetryDelay)
      sinon.assert.calledOnce(retryTimer.unref)
      done(err)
    })
  })

  it('preserves backoff when the request timeout exceeds the final flush budget', (done) => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    retryStubs.getRetryDelay.returns(5000)
    const realSetTimeout = setTimeout
    const retryTimer = { unref: sinon.spy() }
    const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((callback, delay, ...args) => {
      if (delay !== 5000) return realSetTimeout(callback, delay, ...args)
      queueMicrotask(() => callback(...args))
      return retryTimer
    })

    nock('http://localhost:80')
      .put('/path')
      .reply(500)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 15_000,
      deadline: Date.now() + 10_000,
      retryOnHttpError: true,
    }, (err, res) => {
      setTimeoutStub.restore()
      clock.restore()
      assert.strictEqual(res, 'OK')
      sinon.assert.calledOnce(retryStubs.getRetryDelay)
      sinon.assert.calledOnce(retryTimer.unref)
      done(err)
    })
  })

  it('shortens a network retry delay to fit the remaining final flush budget', (done) => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    retryStubs.getRetryDelay.callsFake(() => {
      clock.tick(7000)
      return 5000
    })
    const realSetTimeout = setTimeout
    const retryTimer = { unref: sinon.spy() }
    const setTimeoutStub = sinon.stub(global, 'setTimeout').callsFake((callback, delay, ...args) => {
      if (delay !== 1000) return realSetTimeout(callback, delay, ...args)
      queueMicrotask(() => callback(...args))
      return retryTimer
    })
    const error = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      deadline: Date.now() + 10_000,
    }, (err, res) => {
      setTimeoutStub.restore()
      clock.restore()
      assert.strictEqual(res, 'OK')
      sinon.assert.calledOnce(retryStubs.getRetryDelay)
      sinon.assert.calledOnce(retryTimer.unref)
      done(err)
    })
  })

  it('fails promptly when an ordinary retry reaches the final flush deadline', (done) => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    retryStubs.getRetryDelay.callsFake(() => {
      clock.tick(10_000)
      return 5000
    })

    nock('http://localhost:80')
      .put('/path')
      .reply(500)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      deadline: Date.now() + 10_000,
      retryOnHttpError: true,
    }, (err, res, statusCode) => {
      clock.restore()
      assert.strictEqual(err.status, 500)
      assert.strictEqual(res, null)
      assert.strictEqual(statusCode, 500)
      sinon.assert.calledOnce(retryStubs.getRetryDelay)
      done()
    })
  })

  it('should not retry permanent HTTP errors when requested', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(499, '', { 'x-test-response': 'permanent' })

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      retryOnHttpError: true,
    }, (err, res, statusCode, headers) => {
      assert.strictEqual(err.status, 499)
      assert.strictEqual(statusCode, 499)
      assert.strictEqual(headers['x-test-response'], 'permanent')
      sinon.assert.notCalled(retryStubs.getRetryDelay)
      done()
    })
  })

  for (const statusCode of [429, 500]) {
    it(`should preserve an exhausted HTTP ${statusCode} response`, (done) => {
      nock('http://localhost:80')
        .put('/path')
        .reply(statusCode)
        .put('/path')
        .reply(statusCode, '', { 'x-test-response': 'exhausted' })

      request(Buffer.from(''), {
        path: '/path',
        method: 'PUT',
        retryOnHttpError: true,
      }, (err, res, finalStatusCode, headers) => {
        assert.strictEqual(err.status, statusCode)
        assert.strictEqual(finalStatusCode, statusCode)
        assert.strictEqual(headers['x-test-response'], 'exhausted')
        done()
      })
    })
  }

  it('should not retry on a non-retriable error code', (done) => {
    const error = Object.assign(new Error('not found'), { code: 'ENOTFOUND' })

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err) => {
      assert.strictEqual(err, error)
      done()
    })
  })

  it('should not retry on an uncoded error', (done) => {
    const error = new Error('Error ECONNRESET')

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err) => {
      assert.strictEqual(err, error)
      done()
    })
  })

  it('should retry on ECONNREFUSED until max attempts and propagate the final error', (done) => {
    maxAttempts = 5

    const error = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })

    nock('http://localhost:80')
      .put('/path')
      .times(5)
      .replyWithError(error)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err) => {
      assert.strictEqual(err, error)
      done()
    })
  })

  it('passes the per-request options into the retry helpers', (done) => {
    const error = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })

    nock('http://test:123')
      .put('/path')
      .replyWithError(error)
      .put('/path')
      .reply(200, 'OK')

    const options = {
      protocol: 'http:',
      hostname: 'test',
      port: 123,
      path: '/path',
      method: 'PUT',
    }

    request(Buffer.from(''), options, (err) => {
      sinon.assert.calledWith(retryStubs.getMaxAttempts, options)
      sinon.assert.calledWith(retryStubs.getRetryDelay, options, 1)
      sinon.assert.calledWith(retryStubs.markEndpointReached, options)
      done(err)
    })
  })

  it('should retry on UDS ENOENT (socket file not yet present)', (done) => {
    const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done(err)
    })
  })

  it('should be able to send form data', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(200, 'OK')

    const form = new FormData()

    form.append('event', '')

    request(form, {
      path: '/path',
      method: 'PUT',
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done()
    })
  })

  it('should be able to send concurrent requests to different hosts', function (done) {
    Promise.all([initHTTPServer(), initHTTPServer()]).then(([shutdownFirst, shutdownSecond]) => {
      // this interval is blocking a socket for the other request
      const intervalId = setInterval(() => {
        request(Buffer.from(''), {
          path: '/',
          method: 'POST',
          hostname: 'localhost',
          protocol: 'http:',
          port: shutdownFirst.port,
        }, () => {})
      }, 1000)

      setTimeout(() => {
        request(Buffer.from(''), {
          path: '/',
          method: 'POST',
          hostname: 'localhost',
          protocol: 'http:',
          port: shutdownSecond.port,
        }, (err, res) => {
          assert.strictEqual(res, 'OK')
          shutdownFirst()
          shutdownSecond()
          clearInterval(intervalId)
          done()
        })
      }, 2000)
    })
  })

  it('should support ipv6 with brackets', (done) => {
    nock('http://[2607:f0d0:1002:51::4]:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': '13',
      },
    })
      .put('/path')
      .reply(200, 'OK')

    request(
      Buffer.from(JSON.stringify({ foo: 'bar' })), {
        url: 'http://[2607:f0d0:1002:51::4]:123/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      },
      (err, res) => {
        assert.strictEqual(res, 'OK')
        done(err)
      })
  })

  // unix:<path> URLs go through parseUrl(), which extracts the socket path
  // and hands it to http.request via options.socketPath. Assert that mapping
  // directly via the http.request spy.
  it('should parse unix domain sockets properly', (done) => {
    const sock = '/tmp/unix_socket'
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    maxAttempts = 1

    request(
      Buffer.from(''), {
        url: 'unix:' + sock,
        method: 'PUT',
      },
      () => {
        const callOptions = http.request.getCall(0).args[0]
        sandbox.restore()
        assert.strictEqual(callOptions.socketPath, sock)
        done()
      })
  })

  it('should parse windows named pipes properly', (done) => {
    const pipe = '//./pipe/datadogtrace'
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    maxAttempts = 1

    request(
      Buffer.from(''), {
        url: 'unix:' + pipe,
        method: 'PUT',
      },
      () => {
        const callOptions = http.request.getCall(0).args[0]
        sandbox.restore()
        assert.strictEqual(callOptions.socketPath, pipe)
        done()
      })
  })

  // Config always hands exporters a URL object (`new URL(...)`), not a string,
  // so the object branch of parseUrl must apply the same named-pipe handling.
  // The URL parser splits `unix://./pipe/foo` into authority `.` + path
  // `/pipe/foo`; without folding `.` back the socket path collapses to
  // `/pipe/foo` and misses the pipe.
  it('should parse windows named pipes given as a URL object properly', (done) => {
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    maxAttempts = 1

    request(
      Buffer.from(''), {
        url: new URL('unix://./pipe/datadogtrace'),
        method: 'PUT',
      },
      () => {
        const callOptions = http.request.getCall(0).args[0]
        sandbox.restore()
        assert.strictEqual(callOptions.socketPath, '//./pipe/datadogtrace')
        done()
      })
  })

  it('should calculate correct Content-Length header for multi-byte characters', (done) => {
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    const body = 'æøå'
    const charLength = body.length
    const byteLength = Buffer.byteLength(body, 'utf-8')

    assert.ok(charLength < byteLength, `Expected ${charLength} < ${byteLength}`)

    nock('http://test:123').post('/').reply(200, 'OK')

    request(
      body,
      {
        host: 'test',
        port: 123,
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
      (err, res) => {
        assert.strictEqual(res, 'OK')
        const { headers } = http.request.getCall(0).args[0]
        sandbox.restore()
        assert.strictEqual(headers['Content-Length'], byteLength)
        done(err)
      }
    )
  })

  describe('when intercepting http', () => {
    const sandbox = sinon.createSandbox()

    beforeEach(() => {
      sandbox.spy(http, 'request')
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('should properly set request host with IPv6', (done) => {
      nock('http://[1337::cafe]:123', {
        reqheaders: {
          'content-type': 'application/octet-stream',
          'content-length': '13',
        },
      })
        .put('/path')
        .reply(200, 'OK')

      request(
        Buffer.from(JSON.stringify({ foo: 'bar' })), {
          url: new URL('http://[1337::cafe]:123/path'),
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
        },
        (err, res) => {
          const options = http.request.getCall(0).args[0]
          assert.strictEqual(options.hostname, '1337::cafe') // no brackets
          assert.strictEqual(res, 'OK')
          done(err)
        })
    })
  })

  describe('with compressed responses', () => {
    it('can decompress gzip responses', (done) => {
      const compressedData = zlib.gzipSync(Buffer.from(JSON.stringify({ foo: 'bar' })))
      nock('http://test:123', {
        reqheaders: {
          'content-type': 'application/json',
          'accept-encoding': 'gzip',
        },
      })
        .post('/path')
        .reply(200, compressedData, { 'content-encoding': 'GZip' })

      request(Buffer.from(''), {
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept-encoding': 'gzip',
        },
      }, (err, res) => {
        assert.strictEqual(res, JSON.stringify({ foo: 'bar' }))
        done(err)
      })
    })

    it('should ignore badly compressed data and log an error', (done) => {
      const badlyCompressedData = 'this is not actually compressed data'
      nock('http://test:123', {
        reqheaders: {
          'content-type': 'application/json',
          'accept-encoding': 'gzip',
        },
      })
        .post('/path')
        .reply(200, badlyCompressedData, { 'content-encoding': 'gzip' })

      request(Buffer.from(''), {
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept-encoding': 'gzip',
        },
      }, (err, res) => {
        sinon.assert.calledWith(log.error, 'Could not gunzip response: %s', 'unexpected end of file')
        assert.strictEqual(res, '')
        done(err)
      })
    })
  })

  it('should drop requests when too much data is buffered', (done) => {
    const bufferSize = 8 * 1024 * 1024
    const buffer = Buffer.alloc(bufferSize).fill(69)

    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': bufferSize,
      },
    })
      .put('/path')
      .times(10)
      .reply(200, 'OK')

    let okCount = 0
    let koCount = 0

    for (let i = 0; i < 10; i++) {
      request(
        stream.Readable.from(buffer),
        {
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
        },
        (err, res) => {
          if (err) return done(err)

          if (res) {
            assert.strictEqual(res, 'OK')
            okCount++
          } else {
            koCount++
          }

          if (okCount + koCount === 10) {
            assert.strictEqual(okCount, 8)
            assert.strictEqual(koCount, 2)
            done()
          }
        })
    }
  })

  it('reports when a final request reaches its deadline under backpressure', async () => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    const bufferSize = 8 * 1024 * 1024
    const buffer = Buffer.alloc(bufferSize)
    const controlledRequests = interceptControlledRequests(8)

    try {
      const activeRequests = startRequests(buffer, 8)

      const deadlineErrorPromise = new Promise(resolve => {
        request(Buffer.from('final'), {
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          deadline: Date.now(),
          headers: {},
        }, resolve)
      })

      await controlledRequests.waitForRequests(8)
      const deadlineError = await deadlineErrorPromise
      assert.strictEqual(deadlineError.code, 'ERR_DD_REQUEST_BUFFER_FULL')

      for (let index = 0; index < 8; index++) controlledRequests.release(index)
      await Promise.all(activeRequests)
      controlledRequests.scope.done()
    } finally {
      clock.restore()
    }
  })

  it('waits for backpressure to clear before sending a final request', async () => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] })
    const bufferSize = 8 * 1024 * 1024
    const buffer = Buffer.alloc(bufferSize)
    const controlledRequests = interceptControlledRequests(9)
    const realSetTimeout = setTimeout
    let retryAfterBackpressure
    const retryTimer = { unref: sinon.spy() }
    sinon.stub(global, 'setTimeout').callsFake((callback, delay, ...args) => {
      if (delay !== 50) return realSetTimeout(callback, delay, ...args)
      retryAfterBackpressure = () => callback(...args)
      return retryTimer
    })

    try {
      const requests = startRequests(buffer, 8)
      requests.push(new Promise((resolve, reject) => {
        request(Buffer.from('final'), {
          protocol: 'http:',
          hostname: 'test',
          port: 123,
          path: '/path',
          method: 'PUT',
          deadline: Date.now() + 1000,
          headers: {},
        }, error => error ? reject(error) : resolve())
      }))

      await controlledRequests.waitForRequests(8)
      assert.strictEqual(typeof retryAfterBackpressure, 'function')
      sinon.assert.calledOnce(retryTimer.unref)

      controlledRequests.release(0)
      await requests[0]
      retryAfterBackpressure()
      await controlledRequests.waitForRequests(9)

      for (let index = 1; index < 9; index++) controlledRequests.release(index)
      await Promise.all(requests)
      controlledRequests.scope.done()
    } finally {
      clock.restore()
    }
  })

  describe('stripping the Datadog API key from a non-TLS connection', () => {
    // `badheaders` only matches when the key is absent, so a passing request proves it was
    // stripped; a regression that left the key on would miss the interceptor and surface here.
    it('strips dd-api-key when sending over http to a non-loopback host', (done) => {
      nock('http://intake.example.com', { badheaders: ['dd-api-key'] })
        .post('/v1/input')
        .reply(200, 'OK')

      request(Buffer.from(''), {
        method: 'POST',
        url: new URL('http://intake.example.com/v1/input'),
        headers: { 'dd-api-key': 'secret-key' },
      }, (err, res) => {
        assert.strictEqual(res, 'OK')
        sinon.assert.calledOnce(log.error)
        assert.match(log.error.getCall(0).args[0], /non-TLS connection/)
        done(err)
      })
    })

    it('strips the DD-API-KEY header casing as well', (done) => {
      nock('http://intake.example.com', { badheaders: ['dd-api-key'] })
        .post('/v1/input')
        .reply(200, 'OK')

      request(Buffer.from(''), {
        method: 'POST',
        url: new URL('http://intake.example.com/v1/input'),
        headers: { 'DD-API-KEY': 'secret-key' },
      }, (err, res) => {
        assert.strictEqual(res, 'OK')
        sinon.assert.calledOnce(log.error)
        done(err)
      })
    })

    it('strips dd-api-key for a non-loopback host that merely starts with "127."', (done) => {
      nock('http://127.evil.com', { badheaders: ['dd-api-key'] })
        .post('/v1/input')
        .reply(200, 'OK')

      request(Buffer.from(''), {
        method: 'POST',
        url: new URL('http://127.evil.com/v1/input'),
        headers: { 'dd-api-key': 'secret-key' },
      }, (err, res) => {
        assert.strictEqual(res, 'OK')
        sinon.assert.calledOnce(log.error)
        done(err)
      })
    })

    for (const loopbackHost of ['127.0.0.1', '127.1.2.3', 'localhost', '[::1]']) {
      it(`keeps dd-api-key over http to the loopback host ${loopbackHost}`, (done) => {
        nock(`http://${loopbackHost}:9999`, {
          reqheaders: { 'dd-api-key': 'secret-key' },
        })
          .post('/v1/input')
          .reply(200, 'OK')

        request(Buffer.from(''), {
          method: 'POST',
          url: new URL(`http://${loopbackHost}:9999/v1/input`),
          headers: { 'dd-api-key': 'secret-key' },
        }, (err, res) => {
          assert.strictEqual(res, 'OK')
          sinon.assert.notCalled(log.error)
          done(err)
        })
      })
    }

    it('keeps dd-api-key over https to a non-loopback host', (done) => {
      nock('https://intake.example.com', {
        reqheaders: { 'dd-api-key': 'secret-key' },
      })
        .post('/v1/input')
        .reply(200, 'OK')

      request(Buffer.from(''), {
        method: 'POST',
        url: new URL('https://intake.example.com/v1/input'),
        headers: { 'dd-api-key': 'secret-key' },
      }, (err, res) => {
        assert.strictEqual(res, 'OK')
        sinon.assert.notCalled(log.error)
        done(err)
      })
    })
  })
})
