'use strict'

const nock = require('nock')

describe('request', function () {
  let request
  let log
  let docker

  beforeEach(() => {
    nock.disableNetConnect()

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
    nock.enableNetConnect()
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
      method: 'PUT'
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from the endpoint: 400 Bad Request')
      done()
    })
  })

  it('should timeout after 2 seconds by default', function (done) {
    this.timeout(2001)
    nock('http://localhost:80')
      .put('/path')
      .delay(10010)
      .reply(200)
      .put('/path')
      .delay(10010)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Request timed out')
      done()
    })
  })

  it('should have a configurable timeout', done => {
    nock('http://localhost:80')
      .put('/path')
      .delay(1010)
      .reply(200)
      .put('/path')
      .delay(1010)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 1000
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Request timed out')
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

  it('should retry with timeouts', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .delay(1010)
      .reply(200)
      .put('/path')
      .reply(200, 'OK')

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 1000
    }, (err, res) => {
      expect(err).to.be.null
      expect(res).to.equal('OK')
      done()
    })
  })

  it('should retry recoverable http statuses', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .reply(408, '')
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
})
