'use strict'

const nock = require('nock')
const request = require('../../../../src/ci-visibility/exporters/agentless/request')
const { expect } = require('chai')

describe('CI Visibility request', () => {
  beforeEach(() => {
    nock.disableNetConnect()
  })

  afterEach(() => {
    nock.cleanAll()
    nock.enableNetConnect()
  })

  it('should send an http request with a JSON string', (done) => {
    nock('http://test:123')
      .post('/path')
      .reply(200, 'OK')

    request(JSON.stringify({ foo: 'bar' }), {
      protocol: 'http:',
      hostname: 'test',
      port: 123,
      path: '/path',
      method: 'POST',
      timeout: 2000,
      headers: {
        'Content-Type': 'application/json'
      }
    }, (err, res) => {
      expect(res).to.equal('OK')
      done(err)
    })
  })

  it('should send an http request with a buffer array', (done) => {
    nock('http://test:123', {
      reqheaders: {
        'content-type': 'application/octet-stream'
      }
    })
      .post('/path')
      .reply(200, 'OK')

    request([Buffer.from('fizz', 'utf-8'), Buffer.from('buzz', 'utf-8')], {
      protocol: 'http:',
      hostname: 'test',
      port: 123,
      path: '/path',
      method: 'POST',
      timeout: 2000,
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    }, (err, res) => {
      expect(res).to.equal('OK')
      done(err)
    })
  })

  it('should handle an http error', done => {
    nock('http://test:123')
      .post('/path')
      .reply(400)

    request('data', {
      protocol: 'http:',
      path: '/path',
      method: 'POST',
      hostname: 'test',
      port: 123
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Error from the intake: 400 Bad Request')
      done()
    })
  })

  it('should timeout after "timeout" seconds', function (done) {
    this.timeout(3000)
    nock('http://test:123')
      .post('/path')
      .times(2)
      .delay(2001)
      .reply(200)

    request('data', {
      protocol: 'http:',
      path: '/path',
      method: 'POST',
      hostname: 'test',
      port: 123,
      timeout: 2000
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the intake: socket hang up')
      done()
    })
  })

  it('should not timeout after less than "timeout" seconds', function (done) {
    this.timeout(3000)
    nock('http://test:123')
      .post('/path')
      .times(2)
      .delay(1900)
      .reply(200)

    request('data', {
      protocol: 'http:',
      path: '/path',
      method: 'POST',
      hostname: 'test',
      port: 123,
      timeout: 2000
    }, err => {
      expect(err).to.be.null
      done()
    })
  })

  it('should retry once and eventually success', function (done) {
    this.timeout(3000)
    nock('http://test:123')
      .post('/path')
      .delay(2100)
      .reply(500)
      .post('/path')
      .reply(200)

    request('data', {
      protocol: 'http:',
      path: '/path',
      method: 'POST',
      hostname: 'test',
      port: 123,
      timeout: 2000
    }, err => {
      expect(err).to.be.null
      done()
    })
  })

  it('should not retry more than once', function (done) {
    this.timeout(3000)
    nock('http://test:123')
      .post('/path')
      .times(2)
      .delay(2100)
      .reply(200)

    request('data', {
      protocol: 'http:',
      path: '/path',
      method: 'POST',
      hostname: 'test',
      port: 123,
      timeout: 2000
    }, err => {
      expect(err).to.be.instanceof(Error)
      expect(err.message).to.equal('Network error trying to reach the intake: socket hang up')
      done()
    })
  })
})
