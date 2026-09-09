'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const { wrapConsole, wrapJestBufferedConsole } = require('../../src/console')

const logSubmissionCh = channel('ci:log-submission:console')

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

  it('publishes supported console methods and preserves their behavior', () => {
    const target = {}
    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      target[method] = sinon.stub().returns(method)
    }
    wrapConsole(target)

    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      assert.strictEqual(target[method]('hello', method), method)
    }

    assert.deepStrictEqual(payloads.map(({ method, args }) => ({ method, args: [...args] })), [
      { method: 'debug', args: ['hello', 'debug'] },
      { method: 'error', args: ['hello', 'error'] },
      { method: 'info', args: ['hello', 'info'] },
      { method: 'log', args: ['hello', 'log'] },
      { method: 'warn', args: ['hello', 'warn'] },
    ])
  })

  it('publishes once when one wrapped console delegates to another', () => {
    const innerLog = sinon.stub().returns('result')
    const inner = { log: innerLog }
    const outer = {
      log () {
        return inner.log.apply(inner, arguments)
      },
    }
    wrapConsole(inner)
    wrapConsole(outer)

    assert.strictEqual(outer.log('hello'), 'result')
    assert.deepStrictEqual(payloads.map(({ method, args }) => ({ method, args: [...args] })), [
      { method: 'log', args: ['hello'] },
    ])
    sinon.assert.calledOnceWithExactly(innerLog, 'hello')
  })

  it('captures Jest buffered console records without wrapping public methods', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    wrapJestBufferedConsole(BufferedConsole)
    const buffer = []

    assert.strictEqual(BufferedConsole.write(buffer, 'warn', 'hello'), buffer)
    assert.deepStrictEqual(buffer, ['hello'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', args: ['hello'] }])
  })

  it('does not publish without a subscriber', () => {
    logSubmissionCh.unsubscribe(subscriber)
    const originalLog = sinon.stub()
    const target = { log: originalLog }
    wrapConsole(target)

    target.log('hello')

    sinon.assert.calledOnceWithExactly(originalLog, 'hello')
    assert.deepStrictEqual(payloads, [])
  })
})
