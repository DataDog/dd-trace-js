'use strict'

const assert = require('node:assert/strict')
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

describe('request', function () {
  let request
  let log
  let docker
  let maxAttempts
  let retryStubs

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
      getRetryDelay: sinon.fake.returns(0),
      getMaxAttempts: sinon.fake(() => maxAttempts),
      markEndpointReached: sinon.fake(),
    }
    request = proxyquire('../../../src/exporters/common/request', {
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

  it('should calculate correct Content-Length header for multi-byte characters', (done) => {
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    const body = 'æøå'
    const charLength = body.length
    const byteLength = Buffer.byteLength(body, 'utf-8')

    assert.ok(charLength < byteLength)

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
      sandbox.reset()
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
        .reply(200, compressedData, { 'content-encoding': 'gzip' })

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
})
