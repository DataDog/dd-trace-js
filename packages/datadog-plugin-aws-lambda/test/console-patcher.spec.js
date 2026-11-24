'use strict'

// Source assertions from datadog-lambda-js src/trace/patch-console.spec.ts at da9fc3c0.

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { patchConsole, unpatchConsole } = require('../src/console-patcher')
const SampleMode = { USER_KEEP: 2 }; const TraceSource = { Event: 'event' }
describe('patchConsole', () => {
  let contextService
  let cnsole
  let log
  let info
  let debug
  let error
  let warn
  let trace
  beforeEach(() => {
    log = sinon.stub()
    info = sinon.stub()
    debug = sinon.stub()
    error = sinon.stub()
    warn = sinon.stub()
    trace = sinon.stub()
    cnsole = { log, info, debug, error, warn, trace }
    contextService = { currentTraceContext: null }
    contextService.currentTraceContext = {
      spanContext: {},
      toTraceId: () => '123456',
      toSpanId: () => '78910',
      sampleMode: () => SampleMode.USER_KEEP,
      source: TraceSource.Event,
    }
  })
  afterEach(() => {
    unpatchConsole(cnsole)
  })
  for (const entry of [
    { method: 'log', mock: () => log },
    { method: 'info', mock: () => info },
    { method: 'debug', mock: () => debug },
    { method: 'error', mock: () => error },
    { method: 'warn', mock: () => warn },
    { method: 'trace', mock: () => trace },
  ]) {
    it(`injects trace context into ${entry.method} messages`, () => {
      const { method, mock } = entry
      patchConsole(cnsole, () => contextService.currentTraceContext)
      cnsole[method]('Hello')
      sinon.assert.calledWithExactly(mock(), '[dd.trace_id=123456 dd.span_id=78910] Hello')
    })
  };
  it("doesn't inject trace context when none is present", () => {
    contextService.currentTraceContext = undefined
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log('Hello')
    sinon.assert.calledWithExactly(log, 'Hello')
  })
  it('injects trace context into empty message', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log()
    sinon.assert.calledWithExactly(log, '[dd.trace_id=123456 dd.span_id=78910]')
  })
  it('injects trace context into JSON-style log by adding dd property', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log({ objectKey: 'objectValue', otherObjectKey: 'otherObjectValue' })
    sinon.assert.calledWithExactly(log, {
      objectKey: 'objectValue',
      otherObjectKey: 'otherObjectValue',
      dd: {
        trace_id: '123456',
        span_id: '78910',
      },
    })
  })
  for (const entry of [
    { name: 'array', value: [1, 2, 3], expected: '[dd.trace_id=123456 dd.span_id=78910] 1,2,3' },
    { name: 'null', value: null, expected: '[dd.trace_id=123456 dd.span_id=78910] null' },
    { name: 'number', value: 42, expected: '[dd.trace_id=123456 dd.span_id=78910] 42' },
    { name: 'undefined', value: undefined, expected: '[dd.trace_id=123456 dd.span_id=78910] undefined' },
  ]) {
    it(`injects trace context as string prefix for ${entry.name}`, () => {
      const { value, expected } = entry
      patchConsole(cnsole, () => contextService.currentTraceContext)
      cnsole.log(value)
      sinon.assert.calledWithExactly(log, expected)
    })
  };
  it('injects trace context as string prefix when multiple arguments provided', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log({ key: 'value' }, 'extra arg')
    sinon.assert.calledWithExactly(log, '[dd.trace_id=123456 dd.span_id=78910] [object Object]', 'extra arg')
  })
  it('injects trace context as string prefix for class instances', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    class MyClass {
      value = 'test'
    }
    const instance = new MyClass()
    cnsole.log(instance)
    sinon.assert.calledWithExactly(log, '[dd.trace_id=123456 dd.span_id=78910] [object Object]')
  })
  it('injects trace context into JSON-style log created with Object.create(null)', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    const obj = Object.create(null)
    obj.message = 'test'
    cnsole.log(obj)
    sinon.assert.calledWithExactly(log, {
      message: 'test',
      dd: {
        trace_id: '123456',
        span_id: '78910',
      },
    })
  })
  it('preserves nested objects in JSON format', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log({ level: 'info', nested: { foo: 'bar' } })
    sinon.assert.calledWithExactly(log, {
      level: 'info',
      nested: { foo: 'bar' },
      dd: {
        trace_id: '123456',
        span_id: '78910',
      },
    })
  })
  it('merges trace context with existing dd property', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log({ message: 'test', dd: { existing: 'value' } })
    sinon.assert.calledWithExactly(log, {
      message: 'test',
      dd: {
        existing: 'value',
        trace_id: '123456',
        span_id: '78910',
      },
    })
  })
  it('leaves empty message unmodified when there is no trace context', () => {
    contextService.currentTraceContext = undefined
    patchConsole(cnsole, () => contextService.currentTraceContext)
    cnsole.log()
    sinon.assert.calledWithExactly(log)
  })
  it('leaves unpatched console objects unmodified', () => {
    const originalLog = cnsole.log
    unpatchConsole(cnsole)
    assert.deepStrictEqual(cnsole.log, originalLog)
  })
  it('modifies patched console objects', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    const originalLog = cnsole.log
    unpatchConsole(cnsole)
    assert.notDeepStrictEqual(cnsole.log, originalLog)
  })
  it('patches each console method only once', () => {
    patchConsole(cnsole, () => contextService.currentTraceContext)
    const first = cnsole.log
    patchConsole(cnsole, () => contextService.currentTraceContext)
    assert.strictEqual(cnsole.log, first)
    cnsole.log('message')
    sinon.assert.calledOnceWithExactly(log, '[dd.trace_id=123456 dd.span_id=78910] message')
  })

  it('contains context-reader failure and recovers on the next log call', () => {
    let first = true
    patchConsole(cnsole, () => {
      if (first) { first = false; throw Error('reader failed') }
      return contextService.currentTraceContext
    })
    cnsole.log('first')
    cnsole.log('second')
    assert.deepStrictEqual(log.args, [['first'], ['[dd.trace_id=123456 dd.span_id=78910] second']])
  })

  it('preserves the original console receiver and return value', () => {
    const receiver = {}
    const result = {}
    cnsole.log = function (message) {
      assert.strictEqual(this, receiver)
      assert.strictEqual(message, '[dd.trace_id=123456 dd.span_id=78910] message')
      return result
    }
    patchConsole(cnsole, () => contextService.currentTraceContext)
    assert.strictEqual(cnsole.log.call(receiver, 'message'), result)
  })

  it('preserves an error from the original console method', () => {
    const failure = Error('original console failed')
    cnsole.log = () => { throw failure }
    patchConsole(cnsole, () => contextService.currentTraceContext)
    assert.throws(() => cnsole.log('message'), error => error === failure)
  })
})
