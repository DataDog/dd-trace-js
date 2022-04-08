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
      true,
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
    }, true, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from the endpoint: 400 Bad Request')
      done()
    })
  })

  it('should timeout after 15 seconds by default', function (done) {
    this.timeout(16000)
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(15001)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, true, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the intake: socket hang up')
      done()
    })
  })

  it('should have a configurable timeout', done => {
    nock('http://localhost:80')
      .put('/path')
      .times(2)
      .delay(2001)
      .reply(200)

    request(Buffer.from(''), {
      path: '/path',
      method: 'PUT',
      timeout: 2000
    }, true, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the intake: socket hang up')
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
    }, true, (err, res) => {
      expect(res).to.equal('OK')
    })
  })

  it('should retry', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET' })
      .put('/path')
      .reply(200, 'OK')

    const req = request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, true, (err, res) => {
      expect(log.debug).to.have.been.calledOnceWith('Retrying request to the intake')
      expect(res).to.equal('OK')
      done()
    })
    req.reusedSocket = true
  })

  it('should not retry more than once', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET', message: 'Error ECONNRESET' })
      .put('/path')
      .replyWithError({ code: 'ECONNRESET', message: 'Error ECONNRESET' })

    const req = request(Buffer.from(''), {
      path: '/path',
      method: 'PUT'
    }, true, (err, res) => {
      expect(log.debug).to.have.been.calledOnceWith('Retrying request to the intake')
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the intake: Error ECONNRESET')
      done()
    })
    req.reusedSocket = true
  })
})
