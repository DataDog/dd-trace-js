'use strict'

const nock = require('nock')

wrapIt()

describe('request', () => {
  let request
  let log
  let docker

  beforeEach(() => {
    nock.disableNetConnect()

    log = {
      error: sinon.spy()
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
})
