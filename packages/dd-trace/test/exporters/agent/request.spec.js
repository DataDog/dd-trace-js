'use strict'

const nock = require('nock')

describe('request', () => {
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
    request = proxyquire('../src/exporters/agent/request', {
      './docker': docker,
      '../../log': log
    })
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('should send an http request with a buffer', () => {
    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': '13'
      }
    })
      .put('/path', { foo: 'bar' })
      .reply(200, 'OK')

    return request({
      protocol: 'http:',
      hostname: 'test',
      port: 123,
      path: '/path',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      data: Buffer.from(JSON.stringify({ foo: 'bar' }))
    }, (err, res) => {
      expect(res).to.equal('OK')
    })
  })

  it('should send an http request with a buffer array', () => {
    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream',
        'content-length': '8'
      }
    })
      .put('/path', 'fizzbuzz')
      .reply(200, 'OK')

    return request({
      protocol: 'http:',
      hostname: 'test',
      port: 123,
      path: '/path',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      data: [Buffer.from('fizz', 'utf-8'), Buffer.from('buzz', 'utf-8')]
    }, (err, res) => {
      expect(res).to.equal('OK')
    })
  })

  it('should handle an http error', done => {
    nock('http://localhost:80')
      .put('/path')
      .reply(400)

    request({
      path: '/path',
      method: 'PUT'
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from the agent: 400 Bad Request')
      done()
    })
  })

  it('should timeout after 2 seconds by default', done => {
    nock('http://localhost:80')
      .put('/path')
      .socketDelay(2001)
      .reply(200)

    request({
      path: '/path',
      method: 'PUT'
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the agent: socket hang up')
      done()
    })
  })

  it('should have a configurable timeout', done => {
    nock('http://localhost:80')
      .put('/path')
      .socketDelay(2001)
      .reply(200)

    request({
      path: '/path',
      method: 'PUT',
      timeout: 2000
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the agent: socket hang up')
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

    return request({
      hostname: 'test',
      port: 123,
      path: '/'
    }, (err, res) => {
      expect(res).to.equal('OK')
    })
  })

  it('should retry under ECONNRESET errors with reusedSocket', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET' })
      .put('/path')
      .reply(200, 'OK')

    const req = request({
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      expect(log.debug).to.have.been.calledOnceWith('Retrying request due to socket connection error')
      expect(res).to.equal('OK')
      done()
    })
    req.reusedSocket = true
  })

  it('should retry under EPIPE errors with reusedSocket', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'EPIPE' })
      .put('/path')
      .reply(200, 'OK')

    const req = request({
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      expect(log.debug).to.have.been.calledOnceWith('Retrying request due to socket connection error')
      expect(res).to.equal('OK')
      done()
    })
    req.reusedSocket = true
  })

  it('should not retry under ECONNRESET errors without reusedSocket', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET', message: 'Error ECONNRESET' })
      .put('/path')
      .reply(200, 'OK')

    const req = request({
      path: '/path',
      method: 'PUT'
    }, (err) => {
      expect(log.debug).not.to.have.been.called
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the agent: Error ECONNRESET')
      done()
    })
    req.reusedSocket = false
  })

  it('should not retry under EPIPE errors without reusedSocket', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'EPIPE', message: 'Error EPIPE' })
      .put('/path')
      .reply(200, 'OK')

    const req = request({
      path: '/path',
      method: 'PUT'
    }, (err) => {
      expect(log.debug).not.to.have.been.called
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the agent: Error EPIPE')
      done()
    })
    req.reusedSocket = false
  })

  it('should not retry more than once', (done) => {
    nock('http://localhost:80')
      .put('/path')
      .replyWithError({ code: 'ECONNRESET', message: 'Error ECONNRESET' })
      .put('/path')
      .replyWithError({ code: 'ECONNRESET', message: 'Error ECONNRESET' })

    const req = request({
      path: '/path',
      method: 'PUT'
    }, (err, res) => {
      expect(log.debug).to.have.been.calledOnceWith('Retrying request due to socket connection error')
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the agent: Error ECONNRESET')
      done()
    })
    req.reusedSocket = true
  })
})
