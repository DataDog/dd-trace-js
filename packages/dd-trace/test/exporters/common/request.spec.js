'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const zlib = require('node:zlib')
const { setTimeout: delay } = require('node:timers/promises')
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

const initSlowAgentHTTPServer = () => {
  return new Promise(resolve => {
    const sockets = []
    let requestCount = 0
    /** @type {import('node:http').ServerResponse | null} */
    let firstRes = null
    let releaseRequested = false

    const maybeReleaseFirst = () => {
      if (!releaseRequested || !firstRes) return
      firstRes.writeHead(200, { Connection: 'close' })
      firstRes.end('OK')
      firstRes = null
    }

    const requestListener = function (req, res) {
      requestCount++

      // Keep the first request open to simulate a slow/unresponsive agent.
      if (!firstRes) {
        firstRes = res
        maybeReleaseFirst()
        return
      }

      res.writeHead(200, { Connection: 'close' })
      res.end('OK')
    }

    const server = http.createServer(requestListener)
    server.on('connection', socket => sockets.push(socket))

    server.listen(0, () => {
      const shutdown = () => {
        sockets.forEach(socket => socket.end())
        server.close()
      }

      shutdown.port = (/** @type {import('net').AddressInfo} */ (server.address())).port
      shutdown.releaseFirst = () => {
        releaseRequested = true
        maybeReleaseFirst()
      }
      shutdown.requestCount = () => requestCount

      resolve(shutdown)
    })
  })
}

describe('request', function () {
  let request
  let log
  let docker

  beforeEach(() => {
    log = {
      error: sinon.spy(),
      debug: sinon.spy()
    }
    docker = {
      inject (carrier) {
        carrier['datadog-container-id'] = 'abcd'
      }
    }
    request = proxyquire('../../../src/exporters/common/request', {
      './docker': docker,
      '../../log': log
    })
  })

  afterEach(() => {
    nock.cleanAll()
  })

  it('should send an http request with a buffer', (done) => {
    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': '13'
      }
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
          'Content-Type': 'application/octet-stream'
        }
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
      port: 8080
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
      url: new URL('http://api.datadog.com/')
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'Error from http://api.datadog.com/path: 400 Bad Request.')
      done()
    })
  })

  // TODO: use fake timers to avoid delaying tests
  it('should timeout after 2 seconds by default', function (done) {
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(2001)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'socket hang up')
      done()
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
      timeout: 100
    }, err => {
      assert.ok(err instanceof Error)
      assert.strictEqual(err.message, 'socket hang up')
      done()
    })
  })

  it('should inject the container ID', () => {
    nock('http://test:123', {
      reqheaders: {
        'datadog-container-id': 'abcd'
      }
    })
      .get('/')
      .reply(200, 'OK')

    return request(Buffer.from(''), {
      hostname: 'test',
      port: 123,
      path: '/'
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
    })
  })

  it('should retry', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET' })
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      assert.strictEqual(res, 'OK')
      done()
    })
  })

  it('should not retry more than once', (done) => {
    const error = new Error('Error ECONNRESET')

    nock('http://localhost:80')
      .put('/path')
      .replyWithError(error)
      .put('/path')
      .replyWithError(error)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      assert.strictEqual(err, error)
      done()
    })
  })

  it('should discard payloads when agent is slow and maxActiveRequests is reached', async () => {
    const shutdown = await initSlowAgentHTTPServer()

    const makeCall = () => {
      return new Promise(resolve => {
        request(Buffer.from(''), {
          path: '/',
          method: 'PUT',
          hostname: 'localhost',
          protocol: 'http:',
          port: shutdown.port,
          timeout: 1000
        }, (err, res) => resolve({ err, res }))
      })
    }

    const promises = Array.from({ length: 9 }, () => makeCall())

    // The 9th request should be dropped immediately because maxActiveRequests is 8.
    const dropped = await Promise.race([
      promises[8],
      delay(200).then(() => {
        throw new Error('Expected dropped request callback to be called quickly.')
      })
    ])

    assert.strictEqual(dropped.err, null)
    assert.strictEqual(dropped.res, undefined)

    // Let the blocked request go through so the queued ones can drain.
    shutdown.releaseFirst()

    const results = await Promise.all(promises.slice(0, 8))
    for (const { err, res } of results) {
      assert.ifError(err)
      assert.strictEqual(res, 'OK')
    }

    assert.strictEqual(shutdown.requestCount(), 8)
    shutdown()
  })

  it('should be able to send form data', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(200, 'OK')

    const form = new FormData()

    form.append('event', '')

    request(form, {
      path: '/path',
      method: 'PUT'
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
          port: shutdownFirst.port
        }, () => {})
      }, 1000)

      setTimeout(() => {
        request(Buffer.from(''), {
          path: '/',
          method: 'POST',
          hostname: 'localhost',
          protocol: 'http:',
          port: shutdownSecond.port
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
        'content-length': '13'
      }
    })
      .put('/path')
      .reply(200, 'OK')

    request(
      Buffer.from(JSON.stringify({ foo: 'bar' })), {
        url: 'http://[2607:f0d0:1002:51::4]:123/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      },
      (err, res) => {
        assert.strictEqual(res, 'OK')
        done(err)
      })
  })

  it('should parse unix domain sockets properly', (done) => {
    const sock = '/tmp/unix_socket'

    request(
      Buffer.from(''), {
        url: 'unix:' + sock,
        method: 'PUT'
      },
      (err, _) => {
        assert.strictEqual(err.address, sock)
        done()
      })
  })

  it('should parse windows named pipes properly', (done) => {
    const pipe = '//./pipe/datadogtrace'

    request(
      Buffer.from(''), {
        url: 'unix:' + pipe,
        method: 'PUT'
      },
      (err, _) => {
        assert.strictEqual(err.address, pipe)
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
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
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
          'content-length': '13'
        }
      })
        .put('/path')
        .reply(200, 'OK')

      request(
        Buffer.from(JSON.stringify({ foo: 'bar' })), {
          url: new URL('http://[1337::cafe]:123/path'),
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          }
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
          'accept-encoding': 'gzip'
        }
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
          'accept-encoding': 'gzip'
        }
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
          'accept-encoding': 'gzip'
        }
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
          'accept-encoding': 'gzip'
        }
      }, (err, res) => {
        sinon.assert.calledWith(log.error, 'Could not gunzip response: %s', 'unexpected end of file')
        assert.strictEqual(res, '')
        done(err)
      })
    })
  })
})
