'use strict'

const Buffer = require('safe-buffer').Buffer
const semver = require('semver')

wrapIt()

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
        const seed = Buffer.alloc(4)

        seed.writeUInt32BE(0xFF000000)

        randomBytes = sinon.stub().returns(seed)

        sinon.stub(Math, 'random')

        id = proxyquire('../src/platform/node/id', {
          'crypto': { randomBytes }
        })
      })

      afterEach(() => {
        Math.random.restore()
      })

      it('should return a random 63bit ID', () => {
        Math.random.returns(0x0000FF00 / (0xFFFFFFFF + 1))

        expect(id().toBuffer().toString('hex')).to.equal('7f00ff00ff00ff00')
      })
    })

    describe('uuid', () => {
      let uuid

      beforeEach(() => {
        uuid = require('../../../src/platform/node/uuid')
      })

      it('should return a random UUID', () => {
        expect(uuid()).to.match(/^[a-f0-9]{32}$/)
      })

      it('should return part of a random UUID', () => {
        expect(uuid(8)).to.match(/^[a-f0-9]{16}$/)
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

    describe('service', () => {
      let current
      let service
      let readPkgUp

      beforeEach(() => {
        readPkgUp = {
          sync: sinon.stub()
        }

        platform = require('../../../src/platform/node')
        service = proxyquire('../src/platform/node/service', {
          'read-pkg-up': readPkgUp
        })

        current = platform._service
      })

      afterEach(() => {
        platform._service = current
      })

      it('should load the service name from the user module', () => {
        const name = require('./load/direct')

        expect(name).to.equal('foo')
      })

      it('should not load the service name if the module information is unavailable', () => {
        readPkgUp.sync.returns({ pkg: undefined })

        service.call(platform)

        expect(platform._service).to.be.undefined
      })

      it('should work even in subfolders', () => {
        const name = require('./load/indirect')

        expect(name).to.equal('foo')
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
        }).then(res => {
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
        }).then(res => {
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

    describe('runtime', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      describe('id', () => {
        it('should return a UUID', () => {
          expect(platform.runtime().id()).to.match(/^[a-f0-9]{32}$/)
        })

        it('should always return the same ID', () => {
          expect(platform.runtime().id()).to.equal(platform.runtime().id())
        })
      })
    })

    describe('metrics', () => {
      let metrics
      let clock
      let client
      let Client

      beforeEach(() => {
        Client = sinon.spy(function () {
          return client
        })

        client = {
          gauge: sinon.spy(),
          increment: sinon.spy(),
          flush: sinon.spy()
        }

        metrics = proxyquire('../src/platform/node/metrics', {
          './dogstatsd': Client
        })

        clock = sinon.useFakeTimers()

        platform = {
          _config: {
            service: 'service',
            env: 'test',
            hostname: 'localhost',
            dogstatsd: {
              port: 8125
            }
          },
          name: sinon.stub().returns('nodejs'),
          version: sinon.stub().returns('10.0.0'),
          engine: sinon.stub().returns('v8'),
          runtime: sinon.stub().returns({
            id: sinon.stub().returns('1234')
          })
        }
      })

      afterEach(() => {
        clock.restore()
      })

      describe('start', () => {
        it('it should initialize the Dogstatsd client with the correct options', () => {
          metrics.apply(platform).start()

          expect(Client).to.have.been.calledWithMatch({
            host: 'localhost',
            tags: [
              'service:service',
              'runtime-id:1234',
              'env:test'
            ]
          })
        })

        it('should start collecting metrics every 10 seconds', () => {
          metrics.apply(platform).start()

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('cpu.user')
          expect(client.gauge).to.have.been.calledWith('cpu.system')
          expect(client.gauge).to.have.been.calledWith('cpu.total')

          expect(client.gauge).to.have.been.calledWith('mem.rss')
          expect(client.gauge).to.have.been.calledWith('mem.heap_total')
          expect(client.gauge).to.have.been.calledWith('mem.heap_used')

          expect(client.gauge).to.have.been.calledWith('process.uptime')

          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size_executable')
          expect(client.gauge).to.have.been.calledWith('heap.total_physical_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_available_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('heap.heap_size_limit')

          if (semver.gte(process.version, '7.2.0')) {
            expect(client.gauge).to.have.been.calledWith('heap.malloced_memory')
            expect(client.gauge).to.have.been.calledWith('heap.peak_malloced_memory')
          }

          expect(client.gauge).to.have.been.calledWith('event_loop.delay.max')
          expect(client.gauge).to.have.been.calledWith('event_loop.delay.min')
          expect(client.increment).to.have.been.calledWith('event_loop.delay.sum')
          expect(client.gauge).to.have.been.calledWith('event_loop.delay.avg')
          expect(client.gauge).to.have.been.calledWith('event_loop.delay.median')
          expect(client.gauge).to.have.been.calledWith('event_loop.delay.95percentile')
          expect(client.increment).to.have.been.calledWith('event_loop.delay.count')

          expect(client.gauge).to.have.been.calledWith('gc.pause.max')
          expect(client.gauge).to.have.been.calledWith('gc.pause.min')
          expect(client.increment).to.have.been.calledWith('gc.pause.sum')
          expect(client.gauge).to.have.been.calledWith('gc.pause.avg')
          expect(client.gauge).to.have.been.calledWith('gc.pause.median')
          expect(client.gauge).to.have.been.calledWith('gc.pause.95percentile')
          expect(client.increment).to.have.been.calledWith('gc.pause.count')

          expect(client.gauge).to.have.been.calledWith('heap.size.by.space')
          expect(client.gauge).to.have.been.calledWith('heap.used_size.by.space')
          expect(client.gauge).to.have.been.calledWith('heap.available_size.by.space')
          expect(client.gauge).to.have.been.calledWith('heap.physical_size.by.space')

          expect(client.flush).to.have.been.called
        })
      })

      describe('stop', () => {
        it('should stop collecting metrics every 10 seconds', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).stop()

          clock.tick(10000)

          expect(client.gauge).to.not.have.been.called
        })
      })

      describe('increment', () => {
        it('should increment a counter', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1)
        })

        it('should increment a counter with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test', 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
        })
      })

      describe('decrement', () => {
        it('should increment a counter', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).decrement('test')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', -1)
        })

        it('should decrement a counter with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).decrement('test', 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', -1, ['foo:bar'])
        })
      })

      describe('without native metrics', () => {
        beforeEach(() => {
          metrics = proxyquire('../src/platform/node/metrics', {
            './dogstatsd': Client,
            'node-gyp-build': sinon.stub().returns(null)
          })
        })

        it('should fallback to only metrics available to JavaScript code', () => {
          metrics.apply(platform).start()

          clock.tick(10000)

          if (semver.gte(process.version, '6.1.0')) {
            expect(client.gauge).to.have.been.calledWith('cpu.user')
            expect(client.gauge).to.have.been.calledWith('cpu.system')
            expect(client.gauge).to.have.been.calledWith('cpu.total')
          }

          expect(client.gauge).to.have.been.calledWith('mem.rss')
          expect(client.gauge).to.have.been.calledWith('mem.heap_total')
          expect(client.gauge).to.have.been.calledWith('mem.heap_used')

          expect(client.gauge).to.have.been.calledWith('process.uptime')

          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size_executable')
          expect(client.gauge).to.have.been.calledWith('heap.total_physical_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_available_size')
          expect(client.gauge).to.have.been.calledWith('heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('heap.heap_size_limit')

          if (semver.gte(process.version, '7.2.0')) {
            expect(client.gauge).to.have.been.calledWith('heap.malloced_memory')
            expect(client.gauge).to.have.been.calledWith('heap.peak_malloced_memory')
          }

          if (semver.gte(process.version, '6.0.0')) {
            expect(client.gauge).to.have.been.calledWith('heap.size.by.space')
            expect(client.gauge).to.have.been.calledWith('heap.used_size.by.space')
            expect(client.gauge).to.have.been.calledWith('heap.available_size.by.space')
            expect(client.gauge).to.have.been.calledWith('heap.physical_size.by.space')
          }

          expect(client.flush).to.have.been.called
        })
      })
    })
  })
})
