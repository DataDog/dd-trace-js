'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('BunyanHttpStream', () => {
  let BunyanHttpStream
  let clock
  let mockReq
  let mockHttp
  let mockHttps
  let mockLog

  function makeStream (opts = {}) {
    return new BunyanHttpStream({
      host: 'localhost',
      port: 8080,
      flushIntervalMs: 60000, // long enough that timer won't fire during tests
      maxBufferSize: 100,
      ...opts,
    })
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    mockReq = {
      write: sinon.stub(),
      end: sinon.stub(),
      once: sinon.stub(),
      destroy: sinon.stub(),
    }

    mockHttp = { request: sinon.stub().returns(mockReq) }
    mockHttps = { request: sinon.stub().returns(mockReq) }

    mockLog = {
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    }

    BunyanHttpStream = proxyquire('../../src/plugins/bunyan_http_stream', {
      'node:http': mockHttp,
      'node:https': mockHttps,
      '../log': mockLog,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('constructor', () => {
    it('creates a Writable stream in objectMode', () => {
      const stream = makeStream()
      assert.ok(stream.writableObjectMode)
    })

    it('defaults to http when protocol is not set', () => {
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {})
      assert.strictEqual(mockHttp.request.callCount, 1)
      assert.strictEqual(mockHttps.request.callCount, 0)
    })

    it('uses https when protocol is https:', () => {
      const stream = makeStream({ protocol: 'https:', maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {})
      assert.strictEqual(mockHttps.request.callCount, 1)
      assert.strictEqual(mockHttp.request.callCount, 0)
    })

    it('uses http when protocol is http:', () => {
      const stream = makeStream({ protocol: 'http:', maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {})
      assert.strictEqual(mockHttp.request.callCount, 1)
    })

    it('defaults path to /logs', () => {
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {})
      const [opts] = mockHttp.request.firstCall.args
      assert.strictEqual(opts.path, '/logs')
    })

    it('registers an exit handler via dd-trace beforeExitHandlers', () => {
      const { beforeExitHandlers } = globalThis[Symbol.for('dd-trace')]
      const sizeBefore = beforeExitHandlers.size
      makeStream()
      assert.strictEqual(beforeExitHandlers.size, sizeBefore + 1)
    })
  })

  describe('_write', () => {
    it('buffers a log record and calls the callback', (done) => {
      const stream = makeStream()
      stream._write({ level: 30, msg: 'hello' }, '', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('flushes when buffer reaches maxBufferSize', (done) => {
      const stream = makeStream({ maxBufferSize: 2 })
      stream._write({ msg: 'a' }, '', () => {})
      stream._write({ msg: 'b' }, '', () => {
        assert.strictEqual(mockHttp.request.callCount, 1)
        done()
      })
    })

    it('does not flush before reaching maxBufferSize', (done) => {
      const stream = makeStream({ maxBufferSize: 3 })
      stream._write({ msg: 'a' }, '', () => {})
      stream._write({ msg: 'b' }, '', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('always calls the callback', (done) => {
      const stream = makeStream()
      stream._write({ msg: 'ok' }, '', done)
    })
  })

  describe('flush', () => {
    it('does not make a request when buffer is empty', () => {
      const stream = makeStream()
      stream.close()
      assert.strictEqual(mockHttp.request.callCount, 0)
    })

    it('sends buffered records as a JSON POST', (done) => {
      const record = { level: 30, msg: 'test message' }
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write(record, '', () => {
        assert.strictEqual(mockHttp.request.callCount, 1)
        const [opts] = mockHttp.request.firstCall.args
        assert.strictEqual(opts.method, 'POST')
        assert.strictEqual(opts.hostname, 'localhost')
        assert.strictEqual(opts.port, 8080)
        assert.strictEqual(opts.headers['Content-Type'], 'application/json')
        const payload = JSON.parse(mockReq.write.firstCall.args[0])
        assert.deepStrictEqual(payload, [record])
        done()
      })
    })

    it('sends to the configured path', (done) => {
      const stream = makeStream({ path: '/my-logs', maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {
        const [opts] = mockHttp.request.firstCall.args
        assert.strictEqual(opts.path, '/my-logs')
        done()
      })
    })

    it('clears the buffer after flushing so subsequent writes flush independently', (done) => {
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'a' }, '', () => {
        stream._write({ msg: 'b' }, '', () => {
          assert.strictEqual(mockHttp.request.callCount, 2)
          done()
        })
      })
    })

    it('writes the payload and ends the request', (done) => {
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'x' }, '', () => {
        assert.ok(mockReq.write.calledOnce)
        assert.ok(mockReq.end.calledOnce)
        done()
      })
    })

    it('handles request errors silently without crashing', (done) => {
      let errorHandler
      mockReq.once.callsFake((event, handler) => {
        if (event === 'error') errorHandler = handler
      })
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'test' }, '', () => {
        assert.doesNotThrow(() => errorHandler(new Error('ECONNREFUSED')))
        done()
      })
    })

    it('destroys the request on timeout', (done) => {
      let timeoutHandler
      mockReq.once.callsFake((event, handler) => {
        if (event === 'timeout') timeoutHandler = handler
      })
      const stream = makeStream({ maxBufferSize: 1 })
      stream._write({ msg: 'test' }, '', () => {
        timeoutHandler()
        assert.ok(mockReq.destroy.calledOnce)
        done()
      })
    })
  })

  describe('timer-based flush', () => {
    it('flushes on timer tick', () => {
      const stream = makeStream({ flushIntervalMs: 1000 })
      stream._write({ msg: 'buffered' }, '', () => {})
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, 1)
    })

    it('does not flush when buffer is empty on timer tick', () => {
      makeStream({ flushIntervalMs: 1000 })
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, 0)
    })
  })

  describe('close', () => {
    it('flushes buffered records', () => {
      const stream = makeStream()
      stream._write({ msg: 'pending' }, '', () => {})
      stream.close()
      assert.strictEqual(mockHttp.request.callCount, 1)
    })

    it('stops the flush timer after close', () => {
      const stream = makeStream({ flushIntervalMs: 1000 })
      stream._write({ msg: 'a' }, '', () => {})
      stream.close()
      const callsAfterClose = mockHttp.request.callCount
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, callsAfterClose)
    })

    it('is safe to call multiple times', () => {
      const stream = makeStream()
      stream.close()
      assert.doesNotThrow(() => stream.close())
    })
  })
})
