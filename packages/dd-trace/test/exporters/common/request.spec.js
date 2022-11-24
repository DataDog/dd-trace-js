'use strict'

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
    nock('http://localhost:80')
      .put('/path')
      .reply(400)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      port: 80
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from localhost:80/path: 400 Bad Request.')
      done()
    })
  })

  it('should timeout after 2 seconds by default', function (done) {
    this.timeout(2001)
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(15001)
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
      .delay(1001)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 1000
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
    this.timeout(10000)
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
})
