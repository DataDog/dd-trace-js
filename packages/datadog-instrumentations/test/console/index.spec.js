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

  it('publishes warnings and errors and preserves all console methods', () => {
    const target = {}
    const originalMethods = {}
    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      originalMethods[method] = target[method] = sinon.stub().returns(method)
    }
    wrapConsole(target)

    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      assert.strictEqual(target[method]('hello', method), method)
    }
    for (const method of ['debug', 'info', 'log']) {
      assert.strictEqual(target[method], originalMethods[method])
    }

    assert.deepStrictEqual(payloads.map(({ method, args }) => ({ method, args: [...args] })), [
      { method: 'error', args: ['hello', 'error'] },
      { method: 'warn', args: ['hello', 'warn'] },
    ])
  })

  it('publishes once when one wrapped console delegates to another', () => {
    const innerWarn = sinon.stub().returns('result')
    const inner = { warn: innerWarn }
    const outer = {
      warn () {
        return inner.warn.apply(inner, arguments)
      },
    }
    wrapConsole(inner)
    wrapConsole(outer)

    assert.strictEqual(outer.warn('hello'), 'result')
    assert.deepStrictEqual(payloads.map(({ method, args }) => ({ method, args: [...args] })), [
      { method: 'warn', args: ['hello'] },
    ])
    sinon.assert.calledOnceWithExactly(innerWarn, 'hello')
  })

  it('captures only Jest buffered warnings and errors without wrapping public methods', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    wrapJestBufferedConsole(BufferedConsole)
    const buffer = []

    assert.strictEqual(BufferedConsole.write(buffer, 'log', 'ignored'), buffer)
    assert.strictEqual(BufferedConsole.write(buffer, 'warn', 'hello'), buffer)
    assert.strictEqual(BufferedConsole.write(buffer, 'error', 'boom'), buffer)
    assert.deepStrictEqual(buffer, ['ignored', 'hello', 'boom'])
    assert.deepStrictEqual(payloads, [
      { method: 'warn', args: ['hello'] },
      { method: 'error', args: ['boom'] },
    ])
  })

  it('does not publish without a subscriber', () => {
    logSubmissionCh.unsubscribe(subscriber)
    const originalWarn = sinon.stub()
    const target = { warn: originalWarn }
    wrapConsole(target)

    target.warn('hello')

    sinon.assert.calledOnceWithExactly(originalWarn, 'hello')
    assert.deepStrictEqual(payloads, [])
  })
})
