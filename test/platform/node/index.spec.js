'use strict'

const EventEmitter = require('events')
const Buffer = require('safe-buffer').Buffer

describe('Platform', () => {
  describe('Node', () => {
    describe('id', () => {
      let id
      let randomBytes

      beforeEach(() => {
        randomBytes = sinon.stub()
        id = proxyquire('../src/platform/node/id', {
          'crypto': { randomBytes }
        })
      })

      it('should return a random 64bit ID', () => {
        const buffer = Buffer.alloc(8)
        buffer.writeUInt32BE(0x12345678)
        buffer.writeUInt32BE(0x87654321, 4)

        randomBytes.returns(buffer)

        expect(id().toString('16')).to.equal('1234567887654321')
      })
    })

    describe('now', () => {
      let now
      let performanceNow

      beforeEach(() => {
        sinon.stub(Date, 'now').returns(1500000000000)
        performanceNow = sinon.stub().returns(100.1111)
        now = proxyquire('../src/platform/node/now', {
          'performance-now': performanceNow
        })
      })

      afterEach(() => {
        Date.now.restore()
      })

      it('should return the current time in milliseconds with high resolution', () => {
        performanceNow.returns(600.3333)

        expect(now()).to.equal(1500000000500.2222)
      })
    })

    describe('request', () => {
      let request

      beforeEach(() => {
        request = require('../../../src/platform/node/request')
      })

      it('should send an http request with a buffer', () => {
        nock('http://test:123', {
          reqheaders: {
            'content-type': 'application/octet-stream',
            'content-length': '13'
          }
        })
          .put('/path', { foo: 'bar' })
          .reply(200)

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
        })
      })

      it('should handle an http error', done => {
        nock('http://localhost:80')
          .put('/path')
          .reply(400)

        request({
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

        request({
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

        request({
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

    describe('msgpack', () => {
      let msgpack

      beforeEach(() => {
        msgpack = require('../../../src/platform/node/msgpack')
      })

      describe('prefix', () => {
        it('should support fixarray', () => {
          const length = 0xf
          const array = new Array(length)
          const prefixed = msgpack.prefix(array)

          expect(prefixed.length).to.equal(length + 1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0x9f]))
        })

        it('should should support array 16', () => {
          const length = 0xf + 1
          const array = new Array(length)
          const prefixed = msgpack.prefix(array)

          expect(prefixed.length).to.equal(length + 1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0xdc, 0x00, 0x10]))
        })

        it('should should support array 32', () => {
          const length = 0xffff + 1
          const array = new Array(length)
          const prefixed = msgpack.prefix(array)

          expect(prefixed.length).to.equal(length + 1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0xdd, 0x00, 0x01, 0x00, 0x00]))
        })
      })
    })

    describe('context', () => {
      let context

      beforeEach(() => {
        context = require('../../../src/platform/node/context')()
      })

      describe('run', () => {
        it('should shadow the parent context', done => {
          const parentValue = {}
          const childValue = {}

          context.run(() => {
            context._set('span', parentValue)

            setImmediate(() => test())

            context.run(() => {
              context._set('span', childValue)
            })
          })

          function test () {
            context.run(span => {
              expect(span).to.equal(parentValue)
              done()
            })
          }
        })

        it('should store the trace state', done => {
          context.run(() => {
            const trace = context._get('trace')
            const finishedCount = context._get('finished_count')

            expect(trace).to.deep.equal([])
            expect(finishedCount).to.equal(0)

            done()
          })
        })

        it('should pass the current span to new contexts', done => {
          const span = {}

          context.run(() => {
            context._set('span', span)
            test()
          })

          function test () {
            context.run(parent => {
              expect(parent).to.equal(span)
              done()
            })
          }
        })
      })

      describe('span', () => {
        it('should return the current span', () => {
          const span = {}

          context.run(() => {
            context._set('span', span)
            test()
          })

          function test () {
            expect(context.span()).to.equal(span)
          }
        })
      })

      describe('bind', () => {
        it('should bind a function to the context', done => {
          const span = {}

          let test = () => {
            expect(context._get('span')).to.equal(span)
            done()
          }

          context.run(() => {
            test = context.bind(test)
            context._set('span', span)
          })

          test()
        })
      })

      describe('bindEmitter', () => {
        it('should bind an event emitter to the context', () => {
          const span = {}
          const spy = sinon.spy()
          const emitter = new EventEmitter()

          context.run(() => {
            context.bindEmitter(emitter)
            context._set('span', span)

            emitter.on('test', () => spy(context.span()))
          })

          emitter.emit('test')

          expect(spy).to.have.been.calledWith(span)
        })
      })
    })
  })
})
