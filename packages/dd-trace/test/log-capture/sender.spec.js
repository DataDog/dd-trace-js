'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

let sender

const BASE_OPTS = {
  host: 'localhost',
  port: 8080,
  path: '/logs',
  protocol: 'http:',
  maxBufferSize: 100,
  flushIntervalMs: 5000,
  timeoutMs: 5000,
}

describe('LogCaptureSender', () => {
  let clock, httpStub, writeStub

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    writeStub = sinon.stub()
    httpStub = sinon.stub(require('node:http'), 'request').returns({
      once: sinon.stub().returnsThis(),
      write: writeStub,
      end: sinon.stub(),
    })
    delete require.cache[require.resolve('../../src/log-capture/sender')]
    sender = require('../../src/log-capture/sender')
  })

  afterEach(() => {
    clock.restore()
    sinon.restore()
  })

  it('should buffer log records', () => {
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    assert.strictEqual(sender.bufferSize(), 1)
  })

  it('should flush and add when maxBufferSize is reached', () => {
    sender.configure({ ...BASE_OPTS, maxBufferSize: 2 })
    sender.add('{"level":30,"msg":"a"}')
    sender.add('{"level":30,"msg":"b"}')
    // buffer is now full — next add should flush then enqueue
    sender.add('{"level":30,"msg":"c"}')
    assert.ok(httpStub.calledOnce, 'should have flushed when buffer was full')
    assert.strictEqual(sender.bufferSize(), 1)
  })

  it('should flush on interval', () => {
    sender.configure({ ...BASE_OPTS, maxBufferSize: 1000 })
    sender.add('{"level":30,"msg":"hello"}')
    clock.tick(5000)
    assert.ok(httpStub.called)
    assert.strictEqual(sender.bufferSize(), 0)
  })

  it('should not leak timers when configure is called multiple times', () => {
    sender.configure(BASE_OPTS)
    assert.strictEqual(clock.countTimers(), 0)

    sender.configure({ ...BASE_OPTS, flushIntervalMs: 1000 })
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('should not arm a timer when no records are buffered', () => {
    sender.configure(BASE_OPTS)
    clock.tick(10000)
    assert.ok(!httpStub.called, 'should not send when no records were added')
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('should flush records after flushIntervalMs when records are added', () => {
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    assert.strictEqual(clock.countTimers(), 1, 'timer should be armed after first add')
    clock.tick(BASE_OPTS.flushIntervalMs)
    assert.ok(httpStub.called, 'should have flushed after interval')
    assert.strictEqual(sender.bufferSize(), 0)
  })

  it('should flush buffered records immediately when reconfigured', () => {
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')

    sender.configure({ ...BASE_OPTS, flushIntervalMs: 1000 })

    assert.ok(httpStub.calledOnce)
    assert.strictEqual(sender.bufferSize(), 0)
  })

  it('should be a no-op when not configured', () => {
    sender.add('{"level":30,"msg":"hello"}')
    assert.strictEqual(sender.bufferSize(), 0)
  })

  it('should trim trailing newlines from records when flushing', () => {
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"a"}\n')
    sender.add('{"level":30,"msg":"b"}\n')
    sender.flush()
    assert.strictEqual(writeStub.firstCall.args[0], '{"level":30,"msg":"a"}\n{"level":30,"msg":"b"}')
  })

  it('should drain the response body to release the socket', () => {
    const res = { resume: sinon.stub() }
    httpStub.callsFake((_opts, callback) => {
      callback(res)
      return { once: sinon.stub().returnsThis(), write: sinon.stub(), end: sinon.stub() }
    })
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    sender.flush()
    assert.ok(res.resume.calledOnce)
  })

  it('should destroy the request and warn on timeout', () => {
    let timeoutHandler
    const req = {
      once: sinon.stub().callsFake((event, handler) => {
        if (event === 'timeout') timeoutHandler = handler
        return req
      }),
      write: sinon.stub(),
      end: sinon.stub(),
      destroy: sinon.stub(),
    }
    httpStub.returns(req)
    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    sender.flush()
    timeoutHandler()
    assert.ok(req.destroy.calledOnce)
  })

  it('should warn on request error', () => {
    const logModule = require('../../src/log')
    const warnStub = sinon.stub(logModule, 'warn')

    let errorHandler
    const req = {
      once: sinon.stub().callsFake((event, handler) => {
        if (event === 'error') errorHandler = handler
        return req
      }),
      write: sinon.stub(),
      end: sinon.stub(),
    }
    httpStub.returns(req)

    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    sender.flush()

    assert.ok(typeof errorHandler === 'function', 'error handler should be registered')
    errorHandler(new Error('ECONNREFUSED'))
    assert.ok(warnStub.calledOnce, 'log.warn should be called on error')
    warnStub.restore()
  })

  it('should use https when protocol is https:', () => {
    const httpsStub = sinon.stub(require('node:https'), 'request').returns({
      once: sinon.stub().returnsThis(),
      write: sinon.stub(),
      end: sinon.stub(),
    })
    sender.configure({ ...BASE_OPTS, port: 443, protocol: 'https:', maxBufferSize: 1000 })
    sender.add('{"level":30,"msg":"hello"}')
    sender.flush()
    assert.ok(httpsStub.called)
  })

  it('should be a no-op flush when never configured', () => {
    sender.flush()
    assert.ok(!httpStub.called, 'should not send when opts is undefined')
  })

  it('should warn on timeout', () => {
    const logModule = require('../../src/log')
    const warnStub = sinon.stub(logModule, 'warn')

    let timeoutHandler
    const req = {
      once: sinon.stub().callsFake((event, handler) => {
        if (event === 'timeout') timeoutHandler = handler
        return req
      }),
      write: sinon.stub(),
      end: sinon.stub(),
      destroy: sinon.stub(),
    }
    httpStub.returns(req)

    sender.configure(BASE_OPTS)
    sender.add('{"level":30,"msg":"hello"}')
    sender.flush()
    timeoutHandler()
    assert.ok(warnStub.calledOnce, 'log.warn should be called on timeout')
    warnStub.restore()
  })
})
