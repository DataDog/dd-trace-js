'use strict'

const t = require('tap')
require('../../setup/core')

const nock = require('nock')
const getPort = require('get-port')
const http = require('http')
const zlib = require('zlib')

const FormData = require('../../../src/exporters/common/form-data')

const initHTTPServer = (port) => {
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

    server.listen(port, () => {
      resolve(() => {
        sockets.forEach(socket => socket.end())
        server.close()
      })
    })
  })
}

t.test('request', function (t) {
  let request
  let log
  let docker

  t.beforeEach(() => {
    log = {
      error: sinon.spy(),
      debug: sinon.spy()
    }
    docker = {
      inject (carrier) {
        carrier['datadog-container-id'] = 'abcd'
      }
    }
    request = proxyquire('../src/exporters/common/request', {
      './docker': docker,
      '../../log': log
    })
  })

  t.afterEach(() => {
    nock.cleanAll()
  })

  t.test('should send an http request with a buffer', (t) => {
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
        expect(res).to.equal('OK')
        t.error(err)
        t.end()
      })
  })

  t.test('should handle an http error', t => {
    nock('http://localhost:8080')
      .put('/path')
      .reply(400)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      port: 8080
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from http://localhost:8080/path: 400 Bad Request.')
      t.end()
    })
  })

  t.test('should handle an http error when url is specified', t => {
    nock('http://api.datadog.com')
      .put('/path')
      .reply(400)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      url: new URL('http://api.datadog.com/')
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from http://api.datadog.com/path: 400 Bad Request.')
      t.end()
    })
  })

  // TODO: use fake timers to avoid delaying tests
  t.test('should timeout after 2 seconds by default', function (t) {
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(2001)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('socket hang up')
      t.end()
    })
  })

  t.test('should have a configurable timeout', t => {
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
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('socket hang up')
      t.end()
    })
  })

  t.test('should inject the container ID', () => {
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
      expect(res).to.equal('OK')
    })
  })

  t.test('should retry', (t) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET' })
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      expect(res).to.equal('OK')
      t.end()
    })
  })

  t.test('should not retry more than once', (t) => {
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
      expect(err).to.equal(error)
      t.end()
    })
  })

  t.test('should be able to send form data', (t) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(200, 'OK')

    const form = new FormData()

    form.append('event', '')

    request(form, {
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      expect(res).to.equal('OK')
      t.end()
    })
  })

  t.test('should be able to send concurrent requests to different hosts', function (t) {
    // TODO: try to simplify the setup here. I haven't been able to reproduce the
    // concurrent socket issue using nock
    Promise.all([getPort(), getPort()]).then(([port1, port2]) => {
      Promise.all([initHTTPServer(port1), initHTTPServer(port2)]).then(([shutdownFirst, shutdownSecond]) => {
        // this interval is blocking a socket for the other request
        const intervalId = setInterval(() => {
          request(Buffer.from(''), {
            path: '/',
            method: 'POST',
            hostname: 'localhost',
            protocol: 'http:',
            port: port1
          }, () => {})
        }, 1000)

        setTimeout(() => {
          request(Buffer.from(''), {
            path: '/',
            method: 'POST',
            hostname: 'localhost',
            protocol: 'http:',
            port: port2
          }, (err, res) => {
            expect(res).to.equal('OK')
            shutdownFirst()
            shutdownSecond()
            clearInterval(intervalId)
            t.end()
          })
        }, 2000)
      })
    })
  })

  t.test('should support ipv6 with brackets', (t) => {
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
        expect(res).to.equal('OK')
        t.error(err)
        t.end()
      })
  })

  t.test('should parse unix domain sockets properly', (t) => {
    const sock = '/tmp/unix_socket'

    request(
      Buffer.from(''), {
        url: 'unix:' + sock,
        method: 'PUT'
      },
      (err, _) => {
        expect(err.address).to.equal(sock)
        t.end()
      })
  })

  t.test('should parse windows named pipes properly', (t) => {
    const pipe = '//./pipe/datadogtrace'

    request(
      Buffer.from(''), {
        url: 'unix:' + pipe,
        method: 'PUT'
      },
      (err, _) => {
        expect(err.address).to.equal(pipe)
        t.end()
      })
  })

  t.test('should calculate correct Content-Length header for multi-byte characters', (t) => {
    const sandbox = sinon.createSandbox()
    sandbox.spy(http, 'request')

    const body = 'æøå'
    const charLength = body.length
    const byteLength = Buffer.byteLength(body, 'utf-8')

    expect(charLength).to.be.below(byteLength)

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
        expect(res).to.equal('OK')
        const { headers } = http.request.getCall(0).args[0]
        sandbox.restore()
        expect(headers['Content-Length']).to.equal(byteLength)
        t.error(err)
        t.end()
      }
    )
  })

  t.test('when intercepting http', t => {
    const sandbox = sinon.createSandbox()

    t.beforeEach(() => {
      sandbox.spy(http, 'request')
    })

    t.afterEach(() => {
      sandbox.reset()
    })

    t.test('should properly set request host with IPv6', (t) => {
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
          expect(options.hostname).to.equal('1337::cafe') // no brackets
          expect(res).to.equal('OK')
          t.error(err)
          t.end()
        })
    })
    t.end()
  })

  t.test('with compressed responses', t => {
    t.test('can decompress gzip responses', (t) => {
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
        expect(res).to.equal(JSON.stringify({ foo: 'bar' }))
        t.error(err)
        t.end()
      })
    })

    t.test('should ignore badly compressed data and log an error', (t) => {
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
        expect(log.error).to.have.been.calledWith('Could not gunzip response: %s', 'unexpected end of file')
        expect(res).to.equal('')
        t.error(err)
        t.end()
      })
    })
    t.end()
  })
  t.end()
})
