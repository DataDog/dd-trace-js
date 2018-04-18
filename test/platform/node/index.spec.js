'use strict'

const EventEmitter = require('events')
const Buffer = require('safe-buffer').Buffer
const semver = require('semver')

describe('Platform', () => {
  describe('Node', () => {
    let platform

    describe('name', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should return nodejs', () => {
        expect(platform.name()).to.equal('nodejs')
      })
    })

    describe('version', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should return the process version', () => {
        const version = platform.version()

        expect(version).to.be.a('string')
        expect(semver.eq(version, semver.valid(version))).to.be.true
      })
    })

    describe('engine', () => {
      let realEngine

      beforeEach(() => {
        platform = require('../../../src/platform/node')
        realEngine = process.jsEngine
      })

      afterEach(() => {
        process.jsEngine = realEngine
      })

      it('should return the correct engine for Chakra', () => {
        process.jsEngine = 'chakracore'

        expect(platform.engine()).to.equal('chakracore')
      })

      it('should return the correct engine for V8', () => {
        delete process.jsEngine

        expect(platform.engine()).to.equal('v8')
      })
    })

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

    describe('env', () => {
      let env

      beforeEach(() => {
        process.env.FOO = 'bar'
        env = require('../../../src/platform/node/env')
      })

      afterEach(() => {
        delete process.env.FOO
      })

      it('should return the value from the environment variables', () => {
        expect(env('FOO')).to.equal('bar')
      })
    })

    describe('request', () => {
      let request
      let log

      beforeEach(() => {
        nock.disableNetConnect()

        log = {
          error: sinon.spy()
        }
        request = proxyquire('../src/platform/node/request', {
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
            expect(err.message).to.equal('Error from the agent: 400 Bad Request')
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
        })
          .catch(err => {
            expect(err).to.be.instanceof(Error)
            expect(err.message).to.equal('Network error trying to reach the agent: socket hang up')
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
      let namespace
      let cls
      let clsBluebird
      let config

      beforeEach(() => {
        clsBluebird = sinon.spy(require('cls-bluebird'))
        require.cache[require.resolve('cls-bluebird')].exports = clsBluebird
        context = require('../../../src/platform/node/context')
      })

      afterEach(() => {
        cls.destroyNamespace('dd-trace')
      })

      describe('continuation-local-storage', () => {
        beforeEach(() => {
          cls = require('continuation-local-storage')
          config = { experimental: { asyncHooks: false } }
          namespace = context(config)
        })

        testContext('../../../src/platform/node/context/cls')
      })

      if (semver.gte(semver.valid(process.version), '8.2.0')) {
        describe('cls-hooked', () => {
          beforeEach(() => {
            cls = require('cls-hooked')
            config = { experimental: { asyncHooks: true } }
            namespace = context(config)
          })

          testContext('../../../src/platform/node/context/cls_hooked')
        })
      }

      function testContext (modulePath) {
        afterEach(() => {
          delete require.cache[require.resolve(modulePath)]
        })

        it('should use the correct implementation from the experimental flag', () => {
          expect(namespace).to.equal(require(modulePath))
        })

        describe('get/set', () => {
          it('should store a value', done => {
            namespace.run(() => {
              namespace.set('foo', 'bar')
              test()
            })

            function test () {
              namespace.run(() => {
                expect(namespace.get('foo')).to.equal('bar')
                done()
              })
            }
          })
        })

        describe('run', () => {
          it('should not overwrite the parent context', done => {
            const parentValue = 'parent'
            const childValue = 'child'

            namespace.run(() => {
              namespace.set('foo', parentValue)

              setImmediate(() => test())

              namespace.run(() => {
                namespace.set('foo', childValue)
              })
            })

            function test () {
              namespace.run(() => {
                expect(namespace.get('foo')).to.equal('parent')
                done()
              })
            }
          })
        })

        describe('bind', () => {
          it('should bind a function to the context', done => {
            const bar = 'bar'

            let test = () => {
              expect(namespace.get('foo')).to.equal(bar)
              done()
            }

            namespace.run(() => {
              test = namespace.bind(test)
              namespace.set('foo', bar)
            })

            setImmediate(() => test())
          })
        })

        describe('bindEmitter', () => {
          it('should bind an event emitter to the context', () => {
            const bar = {}
            const spy = sinon.spy()
            const emitter = new EventEmitter()

            namespace.run(() => {
              namespace.bindEmitter(emitter)
              namespace.set('foo', bar)

              emitter.on('test', () => spy(namespace.get('foo')))
            })

            emitter.emit('test')

            expect(spy).to.have.been.calledWith(bar)
          })
        })

        it('should support bluebird', done => {
          const Promise = require('bluebird')
          const promise = new Promise((resolve, reject) => {
            setTimeout(resolve)
          })

          namespace.run(() => {
            namespace.set('foo', 'bar')
            promise
              .then(() => {
                expect(namespace.get('foo')).to.equal('bar')
                done()
              })
              .catch(done)
          })
        })

        it('should only patch bluebird once', () => {
          context(config)
          expect(clsBluebird).to.not.have.been.called
        })

        it('should skip patching bluebird on error', () => {
          clsBluebird = proxyquire('../src/platform/node/context/cls_bluebird', {
            'cls-bluebird': () => { throw new Error() }
          })

          expect(() => clsBluebird(namespace)).to.not.throw()
        })
      }
    })
  })
})
