'use strict'

const assert = require('node:assert/strict')
const { Console } = require('node:console')
const { Writable } = require('node:stream')
const { inspect } = require('node:util')

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
    const stream = { write: sinon.stub() }
    const target = { _stderr: stream }
    const originalMethods = {}
    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      originalMethods[method] = target[method] = sinon.stub().callsFake((...args) => {
        if (method === 'error' || method === 'warn') stream.write(`${args.join(' ')}\n`)
        return method
      })
    }
    wrapConsole(target)

    for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
      assert.strictEqual(target[method]('hello', method), method)
    }
    for (const method of ['debug', 'info', 'log']) {
      assert.strictEqual(target[method], originalMethods[method])
    }

    assert.deepStrictEqual(payloads, [
      { method: 'error', message: 'hello error' },
      { method: 'warn', message: 'hello warn' },
    ])
  })

  it('publishes once when one wrapped console delegates to another', () => {
    const stream = { write: sinon.stub() }
    const innerWarn = sinon.stub().callsFake((message) => {
      stream.write(`${message}\n`)
      return 'result'
    })
    const inner = { _stderr: stream, warn: innerWarn }
    const outer = {
      _stderr: stream,
      warn () {
        return inner.warn.apply(inner, arguments)
      },
    }
    wrapConsole(inner)
    wrapConsole(outer)

    assert.strictEqual(outer.warn('hello'), 'result')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
    sinon.assert.calledOnceWithExactly(innerWarn, 'hello')
  })

  it('submits the native-formatted output without inspecting arguments twice', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    let inspections = 0
    const value = {
      [inspect.custom] () {
        inspections++
        if (inspections > 1) throw new Error('inspected twice')
        return 'formatted value'
      },
    }
    wrapConsole(target)

    target.warn('hello %o', value)

    assert.strictEqual(inspections, 1)
    assert.deepStrictEqual(output, ['hello formatted value\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello formatted value' }])
  })

  it('preserves accessor-backed stream writes', () => {
    const originalWrite = sinon.stub()
    let write = originalWrite
    const setter = sinon.spy((value) => { write = value })
    const stream = {}
    Object.defineProperty(stream, 'write', {
      configurable: true,
      get: () => write,
      set: setter,
    })
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('first')
    target.warn('second')

    assert.strictEqual(stream.write, originalWrite)
    sinon.assert.notCalled(setter)
    sinon.assert.calledTwice(originalWrite)
    assert.deepStrictEqual(payloads, [
      { method: 'warn', message: 'first' },
      { method: 'warn', message: 'second' },
    ])
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
      { method: 'warn', message: 'hello' },
      { method: 'error', message: 'boom' },
    ])
  })

  it('does not publish without a subscriber', () => {
    logSubmissionCh.unsubscribe(subscriber)
    const stream = { write: sinon.stub() }
    const originalWarn = sinon.stub().callsFake(message => stream.write(`${message}\n`))
    const target = { _stderr: stream, warn: originalWarn }
    wrapConsole(target)

    target.warn('hello')

    sinon.assert.calledOnceWithExactly(originalWarn, 'hello')
    assert.deepStrictEqual(payloads, [])
  })
})
