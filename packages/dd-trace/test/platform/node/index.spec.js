'use strict'

const nock = require('../../../test/setup/netmock')
const os = require('os')
const semver = require('semver')
const { execSync } = require('child_process')

const AgentExporter = require('../../../src/exporters/agent')
const LogExporter = require('../../../src/exporters/log')

const TIMEOUT_ERROR_MSG = nock.isNetMock ? 'Request Timeout Error' : 'socket hang up'

wrapIt()

describe('Platform', () => {
  describe('Node', () => {
    let platform

    if (os.platform() !== 'win32') {
      describe('in pre-require', () => {
        it('should load the package.json correctly', () => {
          const pkg = JSON.parse(execSync(`node --require ./pkg-loader.js -e ""`, {
            cwd: __dirname
          }).toString())
          expect(pkg.name).to.equal('dd-trace')
        })
      })
    }

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

    describe('crypto', () => {
      let crypto
      let randomBytes
      let buffer

      beforeEach(() => {
        buffer = Buffer.alloc(4)

        buffer.writeUInt32BE(0xabcd1234)

        randomBytes = sinon.stub().returns(buffer)

        crypto = proxyquire('../src/platform/node/crypto', {
          'crypto': { randomBytes }
        })
      })

      it('should fill the typed array with random values', () => {
        const typedArray = new Uint8Array(4)

        crypto.getRandomValues(typedArray)

        expect(typedArray[0]).to.equal(0xab)
        expect(typedArray[1]).to.equal(0xcd)
        expect(typedArray[2]).to.equal(0x12)
        expect(typedArray[3]).to.equal(0x34)
      })
    })

    describe('now', () => {
      let now
      let performanceNow

      beforeEach(() => {
        performanceNow = sinon.stub().returns(100.1111)
        now = proxyquire('../src/platform/node/now', {
          'performance-now': performanceNow
        })
      })

      it('should return the ticks since process start in milliseconds with high resolution', () => {
        expect(now()).to.equal(100.1111)
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
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      afterEach(() => {
        delete process.env['AWS_LAMBDA_FUNCTION_NAME']
      })

      it('should load the service name from the main module', () => {
        const name = platform.service()

        expect(name).to.equal('mocha')
      })

      it('should use the use the lambda function name as the service when in AWS Lambda', () => {
        process.env['AWS_LAMBDA_FUNCTION_NAME'] = 'my-function-name'
        const result = platform.service()
        expect(result).to.equal('my-function-name')
      })
    })

    describe('appVersion', () => {
      beforeEach(() => {
        platform = require('../../../src/platform/node')
      })

      it('should load the version number from the main module', () => {
        const version = platform.appVersion()

        expect(version).to.match(/^\d+.\d+.\d+/)
      })
    })

    describe('request', () => {
      let request
      let log
      let getContainerInfo

      beforeEach(() => {
        nock.disableNetConnect()

        log = {
          error: sinon.spy()
        }
        getContainerInfo = {
          sync: sinon.stub().returns({ containerId: 'abcd' })
        }
        platform = require('../../../src/platform/node')
        request = proxyquire('../src/platform/node/request', {
          'container-info': getContainerInfo,
          '../../log': log
        }).bind(platform)
      })

      afterEach(() => {
        nock.cleanAll()
        nock.enableNetConnect()
      })

      it('should send an http request with a buffer', (done) => {
        nock('http://example.com:123', {
          reqheaders: {
            'content-type': 'application/octet-stream',
            'content-length': '13'
          }
        })
          .put('/path', { foo: 'bar' })
          .reply(200, 'OK')

        return request({
          protocol: 'http:',
          hostname: 'example.com',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          },
          data: Buffer.from(JSON.stringify({ foo: 'bar' }))
        }, (err, res) => {
          expect(res).to.equal('OK')
          done(err)
        })
      })

      it('should send an http request with a buffer array', (done) => {
        nock('http://example.com:123', {
          reqheaders: {
            'content-type': 'application/octet-stream',
            'content-length': '8'
          }
        })
          .put('/path', 'fizzbuzz')
          .reply(200, 'OK')

        return request({
          protocol: 'http:',
          hostname: 'example.com',
          port: 123,
          path: '/path',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          },
          data: [Buffer.from('fizz', 'utf-8'), Buffer.from('buzz', 'utf-8')]
        }, (err, res) => {
          expect(res).to.equal('OK')
          done(err)
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

      it('should timeout after 2 seconds by default', function (done) {
        this.timeout(2500)
        nock('http://localhost:80')
          .put('/path')
          .socketDelay(2001)
          .reply(200, 'soup')

        request({
          path: '/path',
          method: 'PUT'
        }, (err, res) => {
          expect(err).to.be.instanceof(Error)
          expect(err.message).to.equal(`Network error trying to reach the agent: ${TIMEOUT_ERROR_MSG}`)
          done()
        })
      })

      it('should have a configurable timeout', function (done) {
        this.timeout(2500)
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
          expect(err.message).to.equal(`Network error trying to reach the agent: ${TIMEOUT_ERROR_MSG}`)
          done()
        })
      })

      it('should inject the container ID', (done) => {
        nock('http://example.com:123', {
          reqheaders: {
            'datadog-container-id': 'abcd'
          }
        })
          .put('/')
          .reply(200, 'OK')

        return request({
          hostname: 'example.com',
          port: 123,
          method: 'PUT',
          path: '/'
        }, (err, res) => {
          expect(res).to.equal('OK')
          done(err)
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
          const buffer = Buffer.allocUnsafe(5)
          const prefixed = msgpack.prefix(buffer, length)

          expect(prefixed.length).to.equal(1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0x9f]))
        })

        it('should should support array 16', () => {
          const length = 0xf + 1
          const buffer = Buffer.allocUnsafe(5)
          const prefixed = msgpack.prefix(buffer, length)

          expect(prefixed.length).to.equal(1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0xdc, 0x00, 0x10]))
        })

        it('should should support array 32', () => {
          const length = 0xffff + 1
          const buffer = Buffer.allocUnsafe(5)
          const prefixed = msgpack.prefix(buffer, length)

          expect(prefixed.length).to.equal(1)
          expect(prefixed[0]).to.deep.equal(Buffer.from([0xdd, 0x00, 0x01, 0x00, 0x00]))
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
          histogram: sinon.spy(),
          flush: sinon.spy()
        }

        metrics = proxyquire('../src/platform/node/metrics', {
          './dogstatsd': Client
        })

        clock = sinon.useFakeTimers()

        platform = {
          _config: {
            dogstatsd: {
              hostname: 'localhost',
              port: 8125
            },
            tags: {
              str: 'bar',
              obj: {},
              invalid: 't{e*s#t5-:./'
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
              'str:bar',
              'invalid:t_e_s_t5-:./'
            ]
          })
        })

        it('should start collecting metrics every 10 seconds', () => {
          metrics.apply(platform).start()

          global.gc()

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.system')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.total')

          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_total')
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_used')

          expect(client.gauge).to.have.been.calledWith('runtime.node.process.uptime')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size_executable')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_physical_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_available_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.heap_size_limit')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.malloced_memory')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.peak_malloced_memory')

          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.max')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.min')
          expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.sum')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.avg')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.median')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.95percentile')
          expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.count')

          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.max')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.min')
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.sum')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.avg')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.median')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.95percentile')
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.count')

          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.max')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.min')
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.sum')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.avg')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.median')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.95percentile')
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.count')
          expect(client.increment).to.have.been.calledWith(
            'runtime.node.gc.pause.by.type.count', sinon.match.any, sinon.match(val => {
              return val && /^gc_type:[a-z_]+$/.test(val[0])
            })
          )

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.used_size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.available_size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.physical_size.by.space')

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

      describe('histogram', () => {
        it('should add a record to a histogram', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).histogram('test', 1)
          metrics.apply(platform).histogram('test', 2)
          metrics.apply(platform).histogram('test', 3)

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test.max', 3)
          expect(client.gauge).to.have.been.calledWith('test.min', 1)
          expect(client.increment).to.have.been.calledWith('test.sum', 6)
          expect(client.increment).to.have.been.calledWith('test.total', 6)
          expect(client.gauge).to.have.been.calledWith('test.avg', 2)
          expect(client.gauge).to.have.been.calledWith('test.median', 2)
          expect(client.gauge).to.have.been.calledWith('test.95percentile', 3)
          expect(client.increment).to.have.been.calledWith('test.count', 3)
        })
      })

      describe('increment', () => {
        it('should increment a gauge', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1)
        })

        it('should increment a gauge with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test', 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
        })

        it('should increment a monotonic counter', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test', true)

          clock.tick(10000)

          expect(client.increment).to.have.been.calledWith('test', 1)

          client.increment.resetHistory()

          clock.tick(10000)

          expect(client.increment).to.not.have.been.calledWith('test')
        })

        it('should increment a monotonic counter with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).increment('test', 'foo:bar', true)

          clock.tick(10000)

          expect(client.increment).to.have.been.calledWith('test', 1, ['foo:bar'])

          client.increment.resetHistory()

          clock.tick(10000)

          expect(client.increment).to.not.have.been.calledWith('test')
        })
      })

      describe('decrement', () => {
        it('should increment a gauge', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).decrement('test')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', -1)
        })

        it('should decrement a gauge with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).decrement('test', 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', -1, ['foo:bar'])
        })
      })

      describe('gauge', () => {
        it('should set a gauge', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).gauge('test', 10)

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 10)
        })

        it('should set a gauge with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).gauge('test', 10, 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 10, ['foo:bar'])
        })
      })

      describe('boolean', () => {
        it('should set a gauge', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).boolean('test', true)

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1)
        })

        it('should set a gauge with a tag', () => {
          metrics.apply(platform).start()
          metrics.apply(platform).boolean('test', true, 'foo:bar')

          clock.tick(10000)

          expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
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

          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.system')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.total')

          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_total')
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_used')

          expect(client.gauge).to.have.been.calledWith('runtime.node.process.uptime')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size_executable')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_physical_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_available_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.heap_size_limit')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.malloced_memory')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.peak_malloced_memory')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.used_size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.available_size.by.space')
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.physical_size.by.space')

          expect(client.flush).to.have.been.called
        })
      })
    })

    describe('getScope', () => {
      let platform
      let versionDescriptor
      const ASYNC_LOCAL_STORAGE = { name: 'AsyncLocalStorage' }
      const ASYNC_HOOKS = { name: 'async_hooks' }

      beforeEach(() => {
        versionDescriptor = Reflect.getOwnPropertyDescriptor(process.versions, 'node')
      })

      afterEach(() => {
        Reflect.defineProperty(process.versions, 'node', versionDescriptor)
      })

      it('should default to AsyncLocalStorage on supported versions, and async_hooks on unsupported versions', () => {
        function assertVersion (version, als) {
          Reflect.defineProperty(process.versions, 'node', {
            value: version,
            configurable: true
          })
          platform = proxyquire('../src/platform/node/index', {
            '../../scope/async_local_storage': ASYNC_LOCAL_STORAGE,
            '../../scope/async_hooks': ASYNC_HOOKS
          })
          expect(platform.getScope()).to.equal(als ? ASYNC_LOCAL_STORAGE : ASYNC_HOOKS)
        }
        assertVersion('10.0.0', false)
        assertVersion('12.0.0', false)
        assertVersion('12.18.99', false)
        assertVersion('12.19.0', true)
        assertVersion('13.0.0', false)
        assertVersion('14.0.0', false)
        assertVersion('14.4.99', false)
        assertVersion('14.5.0', true)
        assertVersion('14.5.1', true)
        assertVersion('14.6.0', true)
        assertVersion('15.0.0', true)
        assertVersion('16.0.0', true)
        assertVersion('17.0.0', true)
      })

      it('should go with user choice when scope is defined in options', () => {
        expect(platform.getScope('async_local_storage')).to.equal(ASYNC_LOCAL_STORAGE)
        expect(platform.getScope('async_hooks')).to.equal(ASYNC_HOOKS)
      })
    })

    describe('exporter', () => {
      it('should create an AgentExporter by default', () => {
        const Exporter = proxyquire('../src/platform/node/exporter', {
          './env': () => undefined
        })()

        expect(Exporter).to.be.equal(AgentExporter)
      })

      it('should create an LogExporter when in Lambda environment', () => {
        const Exporter = proxyquire('../src/platform/node/exporter', {
          './env': (key) => {
            if (key === 'AWS_LAMBDA_FUNCTION_NAME') {
              return 'my-func'
            }
            return undefined
          }
        })()

        expect(Exporter).to.be.equal(LogExporter)
      })

      it('should allow configuring the exporter', () => {
        const Exporter = proxyquire('../src/platform/node/exporter', {
          './env': () => undefined
        })('log')

        expect(Exporter).to.be.equal(LogExporter)
      })
    })
  })
})
