'use strict'

const Buffer = require('safe-buffer').Buffer

describe('Node Platform', () => {
  let platform

  beforeEach(() => {
    platform = require('../../../src/platform/node')
  })

  describe('request', () => {
    it('should send an http request with a buffer', () => {
      nock('http://test:123', {
        reqheaders: {
          'content-type': 'application/octet-stream',
          'content-length': '13'
        }
      })
        .put('/path', { foo: 'bar' })
        .reply(200)

      return platform.request({
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        data: Buffer.from(JSON.stringify({ foo: 'bar' }))
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
        .reply(200)

      return platform.request({
        protocol: 'http:',
        hostname: 'test',
        port: 123,
        path: '/path',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        data: [Buffer.from('fizz', 'utf-8'), Buffer.from('buzz', 'utf-8')]
      })
    })

    it('should handle an http error', done => {
      nock('http://localhost:80')
        .put('/path')
        .reply(400)

      platform
        .request({
          path: '/path',
          method: 'PUT'
        })
        .catch(err => {
          expect(err).to.be.instanceof(Error)
          expect(err.status).to.equal(400)
          done()
        })
    })

    it('should timeout after 5 seconds by default', done => {
      nock('http://localhost:80')
        .put('/path')
        .socketDelay(5001)
        .reply(200)

      platform
        .request({
          path: '/path',
          method: 'PUT'
        })
        .catch(err => {
          expect(err).to.be.instanceof(Error)
          expect(err.code).to.equal('ECONNRESET')
          done()
        })
    })

    it('should have a configurable timeout', done => {
      nock('http://localhost:80')
        .put('/path')
        .socketDelay(2001)
        .reply(200)

      platform
        .request({
          path: '/path',
          method: 'PUT',
          timeout: 2000
        })
        .catch(err => {
          expect(err).to.be.instanceof(Error)
          expect(err.code).to.equal('ECONNRESET')
          done()
        })
    })
  })

  describe('msgpackArrayPrefix', () => {
    it('should support fixarray', () => {
      const prefix = platform.msgpackArrayPrefix(0xf)

      expect(prefix).to.deep.equal(Buffer.from([0x9f]))
    })

    it('should should support array 16', () => {
      const prefix = platform.msgpackArrayPrefix(0xffff)

      expect(prefix).to.deep.equal(Buffer.from([0xdc, 0xff, 0xff]))
    })

    it('should should support array 32', () => {
      const prefix = platform.msgpackArrayPrefix(0xffffffff)

      expect(prefix).to.deep.equal(Buffer.from([0xdd, 0xff, 0xff, 0xff, 0xff]))
    })
  })
})
