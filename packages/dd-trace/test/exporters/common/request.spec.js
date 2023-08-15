'use strict'

require('../../setup/tap')

const nock = require('nock')
const getPort = require('get-port')
const http = require('http')

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
      id: sinon.stub().returns('abcd')
    }
    request = proxyquire('../src/exporters/common/request', {
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
        expect(res).to.equal('OK')
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
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from http://localhost:8080/path: 400 Bad Request.')
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
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from http://api.datadog.com/path: 400 Bad Request.')
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
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('socket hang up')
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
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('socket hang up')
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
      expect(res).to.equal('OK')
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
      expect(res).to.equal('OK')
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
      expect(err).to.equal(error)
      done()
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
      method: 'PUT'
    }, (err, res) => {
      expect(res).to.equal('OK')
      done()
    })
  })

  it('should be able to send concurrent requests to different hosts', function (done) {
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
            done()
          })
        }, 2000)
      })
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
        expect(res).to.equal('OK')
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
        expect(err.address).to.equal(sock)
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
        expect(err.address).to.equal(pipe)
        done()
      })
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
          expect(options.hostname).to.equal('1337::cafe') // no brackets
          expect(res).to.equal('OK')
          done(err)
        })
    })
  })
})
