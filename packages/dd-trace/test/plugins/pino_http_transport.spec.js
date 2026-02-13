'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('pinoHttpTransport', () => {
  let pinoHttpTransport
  let clock
  let mockReq
  let mockHttp
  let mockHttps

  function makeTransport (opts = {}) {
    return pinoHttpTransport({
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

    pinoHttpTransport = proxyquire('../../src/plugins/pino_http_transport', {
      'node:http': mockHttp,
      'node:https': mockHttps,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  describe('factory', () => {
    it('returns a Writable stream', () => {
      const transport = makeTransport()
      assert.ok(transport instanceof Writable)
    })

    it('uses http by default', () => {
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {})
      assert.strictEqual(mockHttp.request.callCount, 1)
      assert.strictEqual(mockHttps.request.callCount, 0)
    })

    it('uses https when protocol is https:', () => {
      const transport = makeTransport({ protocol: 'https:', maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {})
      assert.strictEqual(mockHttps.request.callCount, 1)
      assert.strictEqual(mockHttp.request.callCount, 0)
    })

    it('registers an exit handler via dd-trace beforeExitHandlers', () => {
      const { beforeExitHandlers } = globalThis[Symbol.for('dd-trace')]
      const sizeBefore = beforeExitHandlers.size
      makeTransport()
      assert.strictEqual(beforeExitHandlers.size, sizeBefore + 1)
    })
  })

  describe('write', () => {
    it('parses NDJSON lines into an internal buffer without flushing', (done) => {
      const transport = makeTransport()
      const chunk = Buffer.from('{"level":30,"msg":"hello"}\n{"level":30,"msg":"world"}\n')
      transport._write(chunk, 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('skips blank/empty lines without error', (done) => {
      const transport = makeTransport()
      transport._write(Buffer.from('\n\n{"level":30}\n\n'), 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('skips whitespace-only lines', (done) => {
      const transport = makeTransport()
      transport._write(Buffer.from('   \n{"level":30}\n   \n'), 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('handles malformed JSON without throwing', (done) => {
      const transport = makeTransport()
      assert.doesNotThrow(() => {
        transport._write(Buffer.from('not-valid-json\n'), 'utf8', done)
      })
    })

    it('always calls the callback', (done) => {
      const transport = makeTransport()
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', done)
    })

    it('flushes when buffer reaches maxBufferSize', (done) => {
      const transport = makeTransport({ maxBufferSize: 2 })
      const chunk = Buffer.from('{"level":30,"msg":"a"}\n{"level":30,"msg":"b"}\n')
      transport._write(chunk, 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 1)
        done()
      })
    })

    it('does not flush before reaching maxBufferSize', (done) => {
      const transport = makeTransport({ maxBufferSize: 5 })
      const chunk = Buffer.from('{"level":30}\n{"level":30}\n{"level":30}\n')
      transport._write(chunk, 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })
  })

  describe('flush', () => {
    it('does not make a request when buffer is empty', (done) => {
      const transport = makeTransport()
      transport._final(() => {
        assert.strictEqual(mockHttp.request.callCount, 0)
        done()
      })
    })

    it('sends buffered records as a JSON POST', (done) => {
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30,"msg":"test"}\n'), 'utf8', () => {
        assert.strictEqual(mockHttp.request.callCount, 1)
        const [opts] = mockHttp.request.firstCall.args
        assert.strictEqual(opts.method, 'POST')
        assert.strictEqual(opts.hostname, 'localhost')
        assert.strictEqual(opts.port, 8080)
        assert.strictEqual(opts.path, '/logs')
        assert.strictEqual(opts.headers['Content-Type'], 'application/json')
        const payload = JSON.parse(mockReq.write.firstCall.args[0])
        assert.deepStrictEqual(payload, [{ level: 30, msg: 'test' }])
        done()
      })
    })

    it('sends to the configured path', (done) => {
      const transport = makeTransport({ path: '/custom-path', maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {
        const [opts] = mockHttp.request.firstCall.args
        assert.strictEqual(opts.path, '/custom-path')
        done()
      })
    })

    it('clears the buffer after flushing', (done) => {
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30,"msg":"a"}\n'), 'utf8', () => {
        transport._write(Buffer.from('{"level":30,"msg":"b"}\n'), 'utf8', () => {
          assert.strictEqual(mockHttp.request.callCount, 2)
          done()
        })
      })
    })

    it('writes the payload and ends the request', (done) => {
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {
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
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {
        assert.doesNotThrow(() => errorHandler(new Error('ECONNREFUSED')))
        done()
      })
    })

    it('destroys the request on timeout', (done) => {
      let timeoutHandler
      mockReq.once.callsFake((event, handler) => {
        if (event === 'timeout') timeoutHandler = handler
      })
      const transport = makeTransport({ maxBufferSize: 1 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {
        timeoutHandler()
        assert.ok(mockReq.destroy.calledOnce)
        done()
      })
    })

    it('flushes on timer tick', () => {
      const transport = makeTransport({ flushIntervalMs: 1000 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {})
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, 1)
    })

    it('does not flush on timer tick when buffer is empty', () => {
      makeTransport({ flushIntervalMs: 1000 })
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, 0)
    })
  })

  describe('final', () => {
    it('flushes remaining buffered records', (done) => {
      const transport = makeTransport()
      transport._write(Buffer.from('{"level":30,"msg":"last"}\n'), 'utf8', () => {})
      transport._final(() => {
        assert.strictEqual(mockHttp.request.callCount, 1)
        const payload = JSON.parse(mockReq.write.firstCall.args[0])
        assert.deepStrictEqual(payload, [{ level: 30, msg: 'last' }])
        done()
      })
    })

    it('calls the callback after flushing', (done) => {
      const transport = makeTransport()
      transport._final(done)
    })

    it('stops the flush timer', () => {
      const transport = makeTransport({ flushIntervalMs: 1000 })
      transport._write(Buffer.from('{"level":30}\n'), 'utf8', () => {})
      transport._final(() => {})
      const callsAfterFinal = mockHttp.request.callCount
      clock.tick(1000)
      assert.strictEqual(mockHttp.request.callCount, callsAfterFinal)
    })
  })
})
