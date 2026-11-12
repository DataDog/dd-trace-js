'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const { wrapConsole, wrapJestConsole } = require('../../src/console')

const configureCh = channel('ci:log-submission:console:configure')
const logSubmissionCh = channel('ci:log-submission:console')
const vitestSuiteStartCh = channel('ci:vitest:test-suite:start')

describe('console instrumentation', () => {
  let payloads
  let subscriber

  beforeEach(() => {
    payloads = []
    subscriber = payload => payloads.push(payload)
    logSubmissionCh.subscribe(subscriber)
  })

  afterEach(() => {
    logSubmissionCh.unsubscribe(subscriber)
  })

  it('captures direct warnings and errors without changing console behavior', () => {
    const logHolder = { dd: { span_id: '1', trace_id: '2' } }
    const target = {
      error: sinon.stub().returns('error result'),
      log: sinon.stub().returns('log result'),
      warn: sinon.stub().returns('warn result'),
    }
    const originalLog = target.log
    wrapConsole(target, () => logHolder)

    assert.strictEqual(target.warn('warning', 42), 'warn result')
    assert.strictEqual(target.error('error'), 'error result')
    assert.strictEqual(target.log('ignored'), 'log result')

    assert.strictEqual(target.log, originalLog)
    assert.deepStrictEqual(payloads, [
      { args: ['warning', 42], logHolder, method: 'warn' },
      { args: ['error'], logHolder, method: 'error' },
    ])
  })

  it('does not capture without an active Test Optimization context', () => {
    const target = { warn: sinon.stub() }
    const getLogHolder = sinon.stub()
    wrapConsole(target, getLogHolder)

    target.warn('outside a test')

    sinon.assert.calledOnce(getLogHolder)
    assert.deepStrictEqual(payloads, [])
  })

  it('does not throw when the console cannot be extended', () => {
    const prototype = { error: sinon.stub(), warn: sinon.stub() }
    const target = Object.freeze(Object.create(prototype))

    wrapConsole(target, sinon.stub())
    target.warn('warning')

    sinon.assert.calledOnceWithExactly(prototype.warn, 'warning')
    assert.deepStrictEqual(payloads, [])
  })

  it('captures Jest buffered and custom console adapters', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    class CustomConsole {
      _logError (method, message) {
        return `${method}: ${message}`
      }
    }
    const logHolder = { dd: { span_id: '1', trace_id: '2' } }
    wrapJestConsole({ BufferedConsole, CustomConsole }, () => logHolder)
    const buffer = []

    assert.strictEqual(BufferedConsole.write(buffer, 'log', 'ignored'), buffer)
    assert.strictEqual(BufferedConsole.write(buffer, 'warn', 'warning'), buffer)
    assert.strictEqual(new CustomConsole()._logError('error', 'failure'), 'error: failure')

    assert.deepStrictEqual(buffer, ['ignored', 'warning'])
    assert.deepStrictEqual(payloads, [
      { args: ['warning'], logHolder, method: 'warn' },
      { args: ['failure'], logHolder, method: 'error' },
    ])
  })

  it('does not wrap Jest console adapters before console submission is configured', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
      }
    }
    const originalWrite = BufferedConsole.write

    wrapJestConsole({ BufferedConsole })
    BufferedConsole.write([], 'warn', 'warning')

    assert.strictEqual(BufferedConsole.write, originalWrite)
    assert.deepStrictEqual(payloads, [])
  })

  it('wraps the active Vitest console after it replaces the global console', () => {
    const originalConsole = globalThis.console
    const initialConsole = { error: sinon.stub(), warn: sinon.stub() }
    const replacement = { error: sinon.stub(), warn: sinon.stub() }
    const logHolder = { dd: { span_id: '1', trace_id: '2' } }

    try {
      globalThis.console = initialConsole
      configureCh.publish({ getLogHolder: () => logHolder })
      globalThis.console = replacement
      vitestSuiteStartCh.publish()
      replacement.warn('warning')
    } finally {
      globalThis.console = originalConsole
    }

    assert.deepStrictEqual(payloads, [{ args: ['warning'], logHolder, method: 'warn' }])
  })
})
