'use strict'

var Buffer = require('safe-buffer').Buffer

describe('Node Platform', function () {
  var platform

  beforeEach(function () {
    platform = require('../../../src/platform/node')
  })

  describe('request', function () {
    it('should send an http request with a buffer', function (done) {
      nock('http://test:123', {
        reqheaders: {
          'content-type': 'application/octet-stream',
          'content-length': '13'
        }
      })
        .put('/path', { foo: 'bar' })
        .reply(200)

      platform.request({
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        data: Buffer.from(JSON.stringify({ foo: 'bar' }))
      }, done)
    })

    it('should handle an http error', function (done) {
      nock('http://localhost:80')
        .put('/path')
        .reply(400)

      return platform.request({
        path: '/path',
        method: 'PUT'
      }, function (err) {
        expect(err).to.be.instanceof(Error)
        expect(err.status).to.equal(400)
        done()
      })
    })

    it('should timeout after 5 seconds by default', function (done) {
      nock('http://localhost:80')
        .put('/path')
        .socketDelay(5001)
        .reply(200)

      return platform.request({
        path: '/path',
        method: 'PUT'
      }, function (err) {
        expect(err).to.be.instanceof(Error)
        expect(err.code).to.equal('ECONNRESET')
        done()
      })
    })

    it('should have a configurable timeout', function (done) {
      nock('http://localhost:80')
        .put('/path')
        .socketDelay(2001)
        .reply(200)

      return platform.request({
        path: '/path',
        method: 'PUT',
        timeout: 2000
      }, function (err) {
        expect(err).to.be.instanceof(Error)
        expect(err.code).to.equal('ECONNRESET')
        done()
      })
    })
  })
})
