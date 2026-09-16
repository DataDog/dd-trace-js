'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { Console } = require('node:console')
const { Writable } = require('node:stream')
const { format, inspect } = require('node:util')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const { wrapConsole, wrapJestBufferedConsole, wrapJestCustomConsole } = require('../../src/console')

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

  it('ignores primitive console replacements', () => {
    for (const target of ['console', 1, true]) {
      wrapConsole(target)
    }
  })

  it('stops traversing cyclic replacement-console prototypes', () => {
    const stream = { write: sinon.stub() }
    const consoleTarget = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    let prototypeReads = 0
    const target = new Proxy(consoleTarget, {
      getPrototypeOf () {
        if (++prototypeReads > 3) throw new Error('prototype read repeatedly')
        return target
      },
    })

    wrapConsole(target)
    target.warn('hello')

    assert.strictEqual(prototypeReads, 1)
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
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

  it('combines sequential stream writes from one console record', () => {
    const output = []
    const stream = { write: chunk => output.push(chunk) }
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write('[warn] ')
        stream.write(message)
        stream.write('\n')
      },
    }
    wrapConsole(target)

    target.warn('hello')

    assert.deepStrictEqual(output, ['[warn] ', 'hello', '\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: '[warn] hello' }])
  })

  it('preserves newline-terminated chunks from one console record', () => {
    const output = []
    const stream = { write: chunk => output.push(chunk) }
    const target = {
      _stderr: stream,
      warn () {
        stream.write('header\n')
        stream.write('details\n')
      },
    }
    wrapConsole(target)

    target.warn()

    assert.deepStrictEqual(output, ['header\n', 'details\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'header\ndetails' }])
  })

  it('captures buffer-backed replacement console writes', () => {
    const output = []
    const stream = { write: chunk => output.push(chunk) }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(new Uint8Array(Buffer.from(`${message}\n`)))
      },
      warn (message) {
        stream.write(Buffer.from(`${message}\n`))
      },
    }
    wrapConsole(target)

    target.warn('warning')
    target.error('error')

    assert.strictEqual(output.length, 2)
    assert.deepStrictEqual(payloads, [
      { method: 'warn', message: 'warning' },
      { method: 'error', message: 'error' },
    ])
  })

  it('excludes complete lines written while a replacement console formats arguments', () => {
    const output = []
    const stream = { write: chunk => output.push(chunk) }
    const target = {
      _stderr: stream,
      warn (...args) {
        stream.write(format(...args))
        stream.write('\n')
      },
    }
    const value = {
      [inspect.custom] () {
        stream.write('unrelated output\n')
        return 'formatted value'
      },
    }
    wrapConsole(target)

    target.warn('hello %o', value)

    assert.deepStrictEqual(output, ['unrelated output\n', 'hello formatted value', '\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello formatted value' }])
  })

  it('publishes a completed replacement-console write when the method later throws', () => {
    const error = new Error('console failure')
    const stream = { write: sinon.stub() }
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
        throw error
      },
    }
    wrapConsole(target)

    assert.throws(() => target.warn('before failure'), error)

    sinon.assert.calledOnceWithExactly(stream.write, 'before failure\n')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'before failure' }])
  })

  it('does not publish a replacement-console write that throws', () => {
    const error = new Error('write failure')
    const stream = { write: sinon.stub().throws(error) }
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    assert.throws(() => target.warn('not written'), error)

    assert.deepStrictEqual(payloads, [])
  })

  it('publishes once when one wrapped console delegates to another', () => {
    const stream = { write: sinon.stub() }
    const innerError = sinon.stub().callsFake((message) => {
      stream.write(`${message}\n`)
      return 'result'
    })
    const inner = { _stderr: stream, error: innerError }
    const outer = {
      _stderr: stream,
      warn () {
        return inner.error.apply(inner, arguments)
      },
    }
    wrapConsole(inner)
    wrapConsole(outer)

    assert.strictEqual(outer.warn('hello'), 'result')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
    sinon.assert.calledOnceWithExactly(innerError, 'hello')
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

  it('captures native Console instances created before prototype instrumentation', () => {
    const stream = { write: sinon.stub() }
    const useStderr = Symbol('kUseStderr')
    const writeToConsole = Symbol('kWriteToConsole')
    class FakeConsole {
      constructor (stream) {
        this._stderr = stream
        this._stderrErrorHandler = () => {}
        this.assert = this.assert.bind(this)
        this.error = this.error.bind(this)
        this.trace = this.trace.bind(this)
        this.warn = this.warn.bind(this)
      }

      assert (expression, message) {
        if (!expression) this.warn(message)
      }

      error (message) {
        this[writeToConsole](useStderr, message)
      }

      trace (message) {
        this.error(message)
      }

      warn (message) {
        this[writeToConsole](useStderr, message)
      }
    }
    Object.defineProperty(FakeConsole.prototype, writeToConsole, {
      configurable: true,
      value (streamSymbol, message) {
        this._stderr.write(`${message}\n`)
      },
      writable: true,
    })
    const target = new FakeConsole(stream)
    const fakeNodeConsole = { Console: FakeConsole, '@noCallThru': true }
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    const caller = {
      assert () { target.error('error from assert caller') },
      trace () { target.warn('warning from trace caller') },
    }

    wrapIsolatedConsole(FakeConsole.prototype)
    target.warn('existing warning')
    target.error('existing error')
    caller.trace()
    caller.assert()
    target.trace('ignored trace')
    target.assert(false, 'ignored assertion')

    sinon.assert.callCount(stream.write, 6)
    sinon.assert.calledWithExactly(stream.write.firstCall, 'existing warning\n')
    sinon.assert.calledWithExactly(stream.write.secondCall, 'existing error\n')
    assert.deepStrictEqual(payloads, [
      { method: 'warn', message: 'existing warning' },
      { method: 'error', message: 'existing error' },
      { method: 'warn', message: 'warning from trace caller' },
      { method: 'error', message: 'error from assert caller' },
    ])
  })

  it('preserves warning severity without relying on stack traces', () => {
    const stream = { write: sinon.stub() }
    const useStderr = Symbol('kUseStderr')
    const formatForStderr = Symbol('kFormatForStderr')
    const writeToConsole = Symbol('kWriteToConsole')
    const warningCh = channel('console.warn')
    class FakeConsole {
      constructor (stream) {
        this._stderr = stream
        this._stderrErrorHandler = () => {}
        this.warn = this.warn.bind(this)
      }

      warn (...args) {
        warningCh.publish(args)
        this[writeToConsole](useStderr, this[formatForStderr](args))
      }
    }
    Object.defineProperties(FakeConsole.prototype, {
      [formatForStderr]: {
        configurable: true,
        value: args => args.join(' '),
        writable: true,
      },
      [writeToConsole]: {
        configurable: true,
        value (streamSymbol, message) {
          this._stderr.write(`${message}\n`)
        },
        writable: true,
      },
    })
    const target = new FakeConsole(stream)
    const fakeNodeConsole = { Console: FakeConsole, '@noCallThru': true }
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    const stackTraceLimit = Error.stackTraceLimit

    try {
      Error.stackTraceLimit = 0
      wrapIsolatedConsole(FakeConsole.prototype)
      target.warn('existing warning')
    } finally {
      Error.stackTraceLimit = stackTraceLimit
    }

    sinon.assert.calledOnceWithExactly(stream.write, 'existing warning\n')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'existing warning' }])
  })

  it('keeps nested pre-instrumentation Console calls as independent records', () => {
    const output = []
    const useStderr = Symbol('kUseStderr')
    const formatForStderr = Symbol('kFormatForStderr')
    const writeToConsole = Symbol('kWriteToConsole')
    class FakeConsole {
      constructor (stream) {
        this._stderr = stream
        this._stderrErrorHandler = () => {}
        this.error = this.error.bind(this)
        this.warn = this.warn.bind(this)
      }

      error (...args) {
        this[writeToConsole](useStderr, this[formatForStderr](args))
      }

      warn (...args) {
        this[writeToConsole](useStderr, this[formatForStderr](args))
      }
    }
    Object.defineProperties(FakeConsole.prototype, {
      [formatForStderr]: {
        configurable: true,
        value: args => args.join(' '),
        writable: true,
      },
      [writeToConsole]: {
        configurable: true,
        value (streamSymbol, message) {
          this._stderr.write(`${message}\n`)
        },
        writable: true,
      },
    })
    const nestedConsole = new FakeConsole({ write: message => output.push(message) })
    const fakeNodeConsole = { Console: FakeConsole, '@noCallThru': true }
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    wrapIsolatedConsole(FakeConsole.prototype)
    const outerConsole = new FakeConsole({
      write (message) {
        output.push(message)
        nestedConsole.error('nested error')
      },
    })

    outerConsole.error('outer error')

    assert.deepStrictEqual(output, ['outer error\n', 'nested error\n'])
    assert.deepStrictEqual(payloads, [
      { method: 'error', message: 'outer error' },
      { method: 'error', message: 'nested error' },
    ])
  })

  it('does not expose a temporary stream writer while formatting a native console record', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const originalWrite = stream.write
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    let hadOwnWrite
    const value = {
      [inspect.custom] () {
        hadOwnWrite = Object.hasOwn(stream, 'write')
        return 'formatted stream'
      },
    }
    wrapConsole(target)

    target.warn(value)

    assert.strictEqual(hadOwnWrite, false)
    assert.strictEqual(stream.write, originalWrite)
    assert.deepStrictEqual(output, ['formatted stream\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'formatted stream' }])
  })

  it('does not expose a temporary stream writer for native Console subclasses', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    class CustomConsole extends Console {}
    const target = new CustomConsole({ stdout: stream, stderr: stream, colorMode: false })
    let hadOwnWrite
    const value = {
      [inspect.custom] () {
        hadOwnWrite = Object.hasOwn(stream, 'write')
        return 'formatted subclass'
      },
    }
    wrapConsole(target)

    target.warn(value)

    assert.strictEqual(hadOwnWrite, false)
    assert.deepStrictEqual(output, ['formatted subclass\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'formatted subclass' }])
  })

  it('does not capture native trace or assertion output', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    wrapConsole(target)

    target.trace('ignored trace')
    target.assert(false, 'ignored assertion')

    assert.strictEqual(output.length, 2)
    assert.deepStrictEqual(payloads, [])
  })

  it('preserves native console group indentation', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    wrapConsole(target)

    target.group()
    target.warn('first\nsecond')
    target.groupEnd()

    assert.deepStrictEqual(output, ['  first\n  second\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: '  first\n  second' }])
  })

  it('captures a replaced method on a native Console instance', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    target.warn = function (message) {
      this._stderr.write(`[custom] ${message}\n`)
    }
    wrapConsole(target)

    target.warn('hello')

    assert.deepStrictEqual(output, ['[custom] hello\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: '[custom] hello' }])
  })

  it('does not publish direct stream writes made while formatting a record', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const value = {
      [inspect.custom] () {
        stream.write('unrelated stderr output\n')
        return 'formatted value'
      },
    }
    wrapConsole(target)

    target.warn('hello %o', value)

    assert.deepStrictEqual(output, ['unrelated stderr output\n', 'hello formatted value\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello formatted value' }])
  })

  it('does not publish console.log output written to the same stream while formatting a record', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const value = {
      [inspect.custom] () {
        target.log('unrelated console output')
        return 'formatted value'
      },
    }
    wrapConsole(target)

    target.error('hello %o', value)

    assert.deepStrictEqual(output, ['unrelated console output\n', 'hello formatted value\n'])
    assert.deepStrictEqual(payloads, [{ method: 'error', message: 'hello formatted value' }])
  })

  it('publishes nested console calls made while formatting another record', () => {
    const context = new AsyncLocalStorage()
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const value = {
      [inspect.custom] () {
        context.run({ dd: { span_id: 'nested' } }, () => target.warn('nested warning'))
        return 'formatted value'
      },
    }
    wrapConsole(target, () => context.getStore())

    context.run({ dd: { span_id: 'outer' } }, () => target.error('outer %o', value))

    assert.deepStrictEqual(output, ['nested warning\n', 'outer formatted value\n'])
    assert.deepStrictEqual(payloads, [
      { logHolder: { dd: { span_id: 'nested' } }, method: 'warn', message: 'nested warning' },
      { logHolder: { dd: { span_id: 'outer' } }, method: 'error', message: 'outer formatted value' },
    ])
  })

  it('publishes reentrant console calls made while writing another record', () => {
    const output = []
    const target = {
      _stderr: {
        write (message) {
          output.push(message)
          if (message === 'outer warning\n') target.error('nested error')
        },
      },
      error (message) {
        this._stderr.write(`${message}\n`)
      },
      warn (message) {
        this._stderr.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('outer warning')

    assert.deepStrictEqual(output, ['outer warning\n', 'nested error\n'])
    assert.deepStrictEqual(payloads, [
      { method: 'warn', message: 'outer warning' },
      { method: 'error', message: 'nested error' },
    ])
  })

  it('does not replace a console record with a reentrant direct stream write', () => {
    const output = []
    let hasReentered = false
    const stream = {
      write (message) {
        output.push(message)
        if (!hasReentered) {
          hasReentered = true
          stream.write('auxiliary write\n')
        }
      },
    }
    const target = {
      _stderr: stream,
      warn (message) {
        this._stderr.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('actual warning')

    assert.deepStrictEqual(output, ['actual warning\n', 'auxiliary write\n'])
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'actual warning' }])
  })

  it('does not read an accessor-backed stderr while instrumenting a console call', () => {
    const stream = { write: sinon.stub() }
    let stderrReads = 0
    const target = {
      warn (message) {
        this._stderr.write(`${message}\n`)
      },
    }
    Object.defineProperty(target, '_stderr', {
      configurable: true,
      get () {
        if (++stderrReads > 1) throw new Error('unexpected stderr read')
        return stream
      },
    })
    wrapConsole(target)

    target.warn('hello')

    assert.strictEqual(stderrReads, 1)
    sinon.assert.calledOnceWithExactly(stream.write, 'hello\n')
    assert.deepStrictEqual(payloads, [])
  })

  it('does not treat a replacement global console as the built-in console', () => {
    const stream = { write: sinon.stub() }
    let stderrReads = 0
    const target = {
      warn (message) {
        this._stderr.write(`${message}\n`)
      },
    }
    Object.defineProperty(target, '_stderr', {
      configurable: true,
      get () {
        if (++stderrReads > 1) throw new Error('unexpected stderr read')
        return stream
      },
    })
    const originalConsole = globalThis.console
    try {
      globalThis.console = target
      wrapConsole(target)
      target.warn('hello')
    } finally {
      globalThis.console = originalConsole
    }

    assert.strictEqual(stderrReads, 1)
    sinon.assert.calledOnceWithExactly(stream.write, 'hello\n')
    assert.deepStrictEqual(payloads, [])
  })

  it('does not invoke a replaced stderr accessor on the built-in console', () => {
    const stream = { write: sinon.stub() }
    const nativeStream = { write: sinon.stub() }
    const fakeNodeConsole = {
      Console: class Console {},
      error (message) {
        this._stderr.write(`${message}\n`)
      },
      warn (message) {
        this._stderr.write(`${message}\n`)
      },
    }
    Object.defineProperty(fakeNodeConsole, '_stderr', {
      configurable: true,
      get: () => nativeStream,
    })
    fakeNodeConsole['@noCallThru'] = true
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    let stderrReads = 0
    Object.defineProperty(fakeNodeConsole, '_stderr', {
      configurable: true,
      get () {
        if (++stderrReads > 1) throw new Error('unexpected stderr read')
        return stream
      },
    })

    wrapIsolatedConsole(fakeNodeConsole)
    fakeNodeConsole.warn('hello')

    assert.strictEqual(stderrReads, 1)
    sinon.assert.calledOnceWithExactly(stream.write, 'hello\n')
    sinon.assert.notCalled(nativeStream.write)
    assert.deepStrictEqual(payloads, [])
  })

  it('captures the bound global console stream when its method is borrowed', () => {
    const globalStream = { write: sinon.stub() }
    const otherStream = { write: sinon.stub() }
    const useStderr = Symbol('kUseStderr')
    const writeToConsole = Symbol('kWriteToConsole')
    class FakeConsole {}
    FakeConsole.prototype[writeToConsole] = function (stream, message) {
      this._stderr.write(message)
    }
    const fakeNodeConsole = {
      Console: FakeConsole,
      _stderr: globalStream,
      error (message) {
        this[writeToConsole](useStderr, `${message}\n`)
      },
      warn (message) {
        this[writeToConsole](useStderr, `${message}\n`)
      },
    }
    fakeNodeConsole[writeToConsole] = FakeConsole.prototype[writeToConsole]
    fakeNodeConsole.error = fakeNodeConsole.error.bind(fakeNodeConsole)
    fakeNodeConsole.warn = fakeNodeConsole.warn.bind(fakeNodeConsole)
    fakeNodeConsole['@noCallThru'] = true
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    wrapIsolatedConsole(fakeNodeConsole)
    const logger = { _stderr: otherStream, warn: fakeNodeConsole.warn }

    logger.warn('hello')

    sinon.assert.calledOnceWithExactly(globalStream.write, 'hello\n')
    sinon.assert.notCalled(otherStream.write)
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
  })

  it('captures a user-bound replacement on the global console', () => {
    const stream = { write: sinon.stub() }
    const useStderr = Symbol('kUseStderr')
    const writeToConsole = Symbol('kWriteToConsole')
    class FakeConsole {}
    FakeConsole.prototype[writeToConsole] = function (streamSymbol, message) {
      this._stderr.write(message)
    }
    const fakeNodeConsole = {
      Console: FakeConsole,
      _stderr: stream,
      error (message) {
        this[writeToConsole](useStderr, `${message}\n`)
      },
      warn (message) {
        this[writeToConsole](useStderr, `${message}\n`)
      },
    }
    fakeNodeConsole[writeToConsole] = FakeConsole.prototype[writeToConsole]
    fakeNodeConsole.error = fakeNodeConsole.error.bind(fakeNodeConsole)
    fakeNodeConsole.warn = fakeNodeConsole.warn.bind(fakeNodeConsole)
    fakeNodeConsole['@noCallThru'] = true
    const { wrapConsole: wrapIsolatedConsole } = proxyquire('../../src/console', {
      'node:console': fakeNodeConsole,
    })
    fakeNodeConsole.warn = function warn (message) {
      this.write(`[custom] ${message}\n`)
    }.bind(stream)

    wrapIsolatedConsole(fakeNodeConsole)
    fakeNodeConsole.warn('hello')

    sinon.assert.calledOnceWithExactly(stream.write, '[custom] hello\n')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: '[custom] hello' }])
  })

  it('does not capture logs when the active context suppresses submission', () => {
    const stream = { write: sinon.stub() }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(`${message}\n`)
      },
    }
    const canCapture = sinon.stub().returns(false)
    wrapConsole(target, undefined, canCapture)

    target.error('tracer diagnostic')

    sinon.assert.calledOnce(canCapture)
    sinon.assert.calledOnceWithExactly(stream.write, 'tracer diagnostic\n')
    assert.deepStrictEqual(payloads, [])
  })

  it('skips accessor-backed replacement console methods', () => {
    const stream = { write: sinon.stub() }
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    const getError = sinon.stub().throws(new Error('unexpected read'))
    Object.defineProperty(target, 'error', {
      configurable: true,
      enumerable: true,
      get: getError,
    })
    const descriptor = Object.getOwnPropertyDescriptor(target, 'error')

    wrapConsole(target)
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(target, 'error'), descriptor)
    sinon.assert.notCalled(getError)

    target.warn('hello')

    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
  })

  it('does not read proxy-backed console methods while wrapping them', () => {
    const stream = { write: sinon.stub() }
    const consoleTarget = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    let warnReads = 0
    const target = new Proxy(consoleTarget, {
      get (target, property, receiver) {
        if (property === 'warn' && ++warnReads > 1) throw new Error('unexpected warn read')
        return Reflect.get(target, property, receiver)
      },
    })

    wrapConsole(target)
    target.warn('hello')

    assert.strictEqual(warnReads, 1)
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'hello' }])
  })

  it('does not throw when the global console accessor cannot be read during configuration', () => {
    let configureSubscriber
    const fakeChannel = name => ({
      hasSubscribers: true,
      publish () {},
      subscribe (subscriber) {
        if (name === 'ci:log-submission:console:configure') configureSubscriber = subscriber
      },
    })
    class FakeConsole {
      error () {}
      warn () {}
    }
    proxyquire('../../src/console', {
      './helpers/instrument': { channel: fakeChannel, '@noCallThru': true },
      'node:console': { Console: FakeConsole, '@noCallThru': true },
    })
    const consoleDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'console')

    try {
      Object.defineProperty(globalThis, 'console', {
        configurable: true,
        get () {
          throw new Error('console unavailable')
        },
      })

      configureSubscriber({})
    } finally {
      Object.defineProperty(globalThis, 'console', consoleDescriptor)
    }
  })

  it('does not throw when a proxy rejects private console symbol inspection', () => {
    const output = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        output.push(chunk.toString())
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor (target, property) {
        if (typeof property === 'symbol') throw new Error('private symbol unavailable')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })

    wrapConsole(proxy)
    proxy.error('hello')

    assert.deepStrictEqual(output, ['hello\n'])
    assert.deepStrictEqual(payloads, [{ method: 'error', message: 'hello' }])
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

  it('resolves accessor-backed stream writes after formatting', () => {
    const staleWrite = sinon.stub().throws(new Error('stale write'))
    const currentWrite = sinon.stub().returns(true)
    let write = staleWrite
    const stream = {}
    Object.defineProperty(stream, 'write', {
      configurable: true,
      get: () => write,
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false, ignoreErrors: false })
    const value = {
      [inspect.custom] () {
        write = currentWrite
        return 'formatted value'
      },
    }
    wrapConsole(target)

    target.warn('%o', value)

    sinon.assert.notCalled(staleWrite)
    sinon.assert.calledOnceWithExactly(currentWrite, 'formatted value\n')
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'formatted value' }])
  })

  it('does not read non-configurable accessor-backed stream writes while instrumenting', () => {
    const originalWrite = sinon.stub()
    let writeReads = 0
    const stream = {}
    Object.defineProperty(stream, 'write', {
      configurable: false,
      get () {
        if (++writeReads > 1) throw new Error('unexpected write read')
        return originalWrite
      },
    })
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('hello')

    assert.strictEqual(writeReads, 1)
    sinon.assert.calledOnceWithExactly(originalWrite, 'hello\n')
    assert.deepStrictEqual(payloads, [])
  })

  it('does not read inherited accessors when the stream cannot be wrapped', () => {
    const originalWrite = sinon.stub()
    let writeReads = 0
    const streamPrototype = {}
    Object.defineProperty(streamPrototype, 'write', {
      configurable: true,
      get () {
        if (++writeReads > 1) throw new Error('unexpected write read')
        return originalWrite
      },
    })
    const stream = Object.preventExtensions(Object.create(streamPrototype))
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('hello')

    assert.strictEqual(writeReads, 1)
    sinon.assert.calledOnceWithExactly(originalWrite, 'hello\n')
    assert.deepStrictEqual(payloads, [])
  })

  it('restores a stream write when descriptor verification fails', () => {
    const originalWrite = sinon.stub()
    let descriptorReads = 0
    const stream = new Proxy({ write: originalWrite }, {
      getOwnPropertyDescriptor (target, property) {
        if (property === 'write' && ++descriptorReads === 2) throw new Error('unexpected descriptor read')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    const target = {
      _stderr: stream,
      warn (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapConsole(target)

    target.warn('first')
    assert.strictEqual(stream.write, originalWrite)
    target.warn('second')

    sinon.assert.calledTwice(originalWrite)
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'second' }])
  })

  it('stops wrapping a stream when restoration fails', () => {
    const originalWrite = sinon.stub()
    let defineCalls = 0
    const stream = new Proxy({ write: originalWrite }, {
      defineProperty (target, property, descriptor) {
        if (property === 'write' && ++defineCalls % 2 === 0) throw new Error('restore failed')
        return Reflect.defineProperty(target, property, descriptor)
      },
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
    target.warn('third')

    assert.strictEqual(defineCalls, 2)
    sinon.assert.calledThrice(originalWrite)
    assert.deepStrictEqual(payloads, [{ method: 'warn', message: 'first' }])
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

  it('publishes once when Jest buffers the same wrapped console write', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const stream = {
      write (message) {
        BufferedConsole.write(buffer, 'error', message.trimEnd())
      },
    }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapJestBufferedConsole(BufferedConsole)
    wrapConsole(target)

    target.error('boom')

    assert.deepStrictEqual(buffer, ['boom'])
    assert.deepStrictEqual(payloads, [{ method: 'error', message: 'boom' }])
  })

  it('publishes a Jest custom console record without resubmitting its rendering', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const output = []
    const stream = { write: message => output.push(message) }
    class CustomConsole {
      constructor () {
        this._stderr = stream
      }

      _logError (method, message) {
        BufferedConsole.write(buffer, method, message)
        stream.write(`console.${method}\n  ${message}\n`)
      }

      error (message) {
        this._logError('error', message)
      }
    }
    const target = new CustomConsole()
    wrapConsole(target)
    wrapJestBufferedConsole(BufferedConsole)
    wrapJestCustomConsole(CustomConsole)

    target.error('boom')

    assert.deepStrictEqual(buffer, ['boom'])
    assert.deepStrictEqual(output, ['console.error\n  boom\n'])
    assert.deepStrictEqual(payloads, [{ method: 'error', message: 'boom' }])
  })

  it('preserves nested Jest buffered records emitted while formatting', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const value = {
      [inspect.custom] () {
        BufferedConsole.write(buffer, 'warn', 'nested warning')
        BufferedConsole.write(buffer, 'error', 'nested error')
        return 'formatted value'
      },
    }
    wrapJestBufferedConsole(BufferedConsole)
    wrapConsole(target)

    target.error('outer %o', value)

    assert.deepStrictEqual(payloads, [
      { method: 'warn', message: 'nested warning' },
      { method: 'error', message: 'nested error' },
      { method: 'error', message: 'outer formatted value' },
    ])
  })

  it('preserves an identical nested Jest buffered record emitted while formatting', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const stream = new Writable({
      write (chunk, encoding, callback) {
        callback()
      },
    })
    const target = new Console({ stdout: stream, stderr: stream, colorMode: false })
    const value = {
      [inspect.custom] () {
        BufferedConsole.write(buffer, 'error', 'outer formatted value')
        return 'formatted value'
      },
    }
    wrapJestBufferedConsole(BufferedConsole)
    wrapConsole(target)

    target.error('outer %o', value)

    assert.deepStrictEqual(payloads, [
      { method: 'error', message: 'outer formatted value' },
      { method: 'error', message: 'outer formatted value' },
    ])
  })

  it('preserves a nested Jest buffered record emitted while writing', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const stream = {
      write () {
        BufferedConsole.write(buffer, 'warn', 'nested warning')
      },
    }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapJestBufferedConsole(BufferedConsole)
    wrapConsole(target)

    target.error('outer error')

    assert.deepStrictEqual(payloads, [
      { method: 'error', message: 'outer error' },
      { method: 'warn', message: 'nested warning' },
    ])
  })

  it('preserves a same-level Jest buffered record emitted while writing', () => {
    class BufferedConsole {
      static write (buffer, method, message) {
        buffer.push(message)
        return buffer
      }
    }
    const buffer = []
    const stream = {
      write () {
        BufferedConsole.write(buffer, 'error', 'nested error')
      },
    }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(`${message}\n`)
      },
    }
    wrapJestBufferedConsole(BufferedConsole)
    wrapConsole(target)

    target.error('outer error')

    assert.deepStrictEqual(payloads, [
      { method: 'error', message: 'outer error' },
      { method: 'error', message: 'nested error' },
    ])
  })

  it('does not resubmit Jest internal console rendering', () => {
    const stream = { write: sinon.stub() }
    const target = {
      _stderr: stream,
      error (message) {
        stream.write(`${message}\n`)
      },
    }
    class BufferedConsole {
      static write (buffer, method, message) {
        target.error(`formatted ${message}`)
        buffer.push(message)
        return buffer
      }
    }
    wrapConsole(target)
    wrapJestBufferedConsole(BufferedConsole)
    const buffer = []

    BufferedConsole.write(buffer, 'error', 'boom')

    assert.deepStrictEqual(buffer, ['boom'])
    sinon.assert.calledOnceWithExactly(stream.write, 'formatted boom\n')
    assert.deepStrictEqual(payloads, [{ method: 'error', message: 'boom' }])
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
