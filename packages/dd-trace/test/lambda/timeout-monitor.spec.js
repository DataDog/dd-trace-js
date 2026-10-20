'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { datadog } = require('../../src/lambda/handler')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')
const HANDLER_HIGHWATERMARK = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
const BEFORE_EXIT = Symbol.for('aws.lambda.beforeExit')

function notCaptured () {
  assert.fail('The handler did not capture its completion callback')
}

describe('Lambda timeout monitor', () => {
  let clock
  let originalTracer
  let originalBeforeExit
  let killAll
  let span
  let context

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    originalTracer = global._ddtrace
    originalBeforeExit = globalThis[BEFORE_EXIT]
    killAll = sinon.spy()
    span = { addTags: sinon.spy(), finish: sinon.spy() }
    global._ddtrace = {
      _tracer: {
        _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 },
        _processor: { killAll },
        scope: () => ({ active: () => span }),
      },
    }
    context = { getRemainingTimeInMillis: () => 100 }
  })

  afterEach(() => {
    clock.restore()
    global._ddtrace = originalTracer
    if (originalBeforeExit === undefined) delete globalThis[BEFORE_EXIT]
    else globalThis[BEFORE_EXIT] = originalBeforeExit
  })

  it('lets an idle void handler reach beforeExit without an impending timeout', () => {
    const script = `
      const { datadog } = require(${JSON.stringify(require.resolve('../../src/lambda/handler'))})
      global._ddtrace = {
        _tracer: {
          _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 },
          _processor: { killAll: () => console.log('timeout') },
          scope: () => ({ active: () => null })
        }
      }
      const beforeExit = Symbol.for('aws.lambda.beforeExit')
      globalThis[beforeExit] = () => console.log('beforeExit')
      process.once('beforeExit', () => globalThis[beforeExit]())
      const handler = datadog(() => undefined)
      handler({}, { getRemainingTimeInMillis: () => 1000 })
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5000 })
    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, 'beforeExit\n')
  })

  for (const hooks of ['absent', 'non-callable']) {
    for (const result of [undefined, new EventEmitter()]) {
      it(`clears an ${result ? 'artifact' : 'undefined'} return with ${hooks} completion hooks`, () => {
        delete globalThis[BEFORE_EXIT]
        if (hooks === 'non-callable') {
          context.done = context.succeed = context.fail = globalThis[BEFORE_EXIT] = {}
        }
        const handler = datadog(() => result)
        assert.strictEqual(handler({}, context), result)
        assert.strictEqual(clock.countTimers(), 0)
        clock.tick(100)
        assert.strictEqual(killAll.callCount, 0)
        assert.strictEqual(span.addTags.callCount, 0)
        assert.strictEqual(span.finish.callCount, 0)
      })
    }
  }

  it('does not leak a hookless return timer into a warm invocation', async () => {
    delete globalThis[BEFORE_EXIT]
    const completed = datadog(() => undefined)
    completed({}, context)
    clock.tick(25)

    /** @type {Function} */
    let resolvePromise = notCaptured
    const pending = datadog(() => new Promise(resolve => { resolvePromise = resolve }))
    const result = pending({}, context)
    clock.tick(50)
    assert.strictEqual(killAll.callCount, 0, 'the completed invocation must not flush the pending invocation')
    assert.strictEqual(clock.countTimers(), 1)
    resolvePromise('done')
    assert.strictEqual(await result, 'done')
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('monitors the selected completion promise instead of a nested handler return', async () => {
    const inner = datadog((_event, _context, _callback) => ({ incidental: true }))
    const handler = datadog((event, context) => Promise.resolve(inner(event, context, () => {})))
    assert.deepStrictEqual(await handler({}, context), { incidental: true })
    assert.strictEqual(clock.countTimers(), 0)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
  })

  it('keeps one monitor while a nested callback handler remains pending', async () => {
    let complete = notCaptured
    const inner = datadog((_event, _context, callback) => { complete = callback })
    const handler = datadog((event, context) => new Promise(resolve => inner(event, context, resolve)))
    const result = handler({}, context)
    assert.strictEqual(clock.countTimers(), 1)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
    complete('done')
    assert.strictEqual(await result, 'done')
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('does not suppress a later monitor after a nested handler throws', () => {
    const error = new Error('handler failure')
    const inner = datadog(() => { throw error })
    const failed = datadog((event, context) => inner(event, context))
    assert.throws(() => failed({}, context), error)
    const pending = datadog(() => new Promise(() => {}))
    pending({}, context)
    assert.strictEqual(clock.countTimers(), 1)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
  })

  for (const unref of [undefined, () => null]) {
    it(`keeps the timer handle when unref ${unref ? 'returns null' : 'is unavailable'}`, () => {
      const setTimeout = global.setTimeout
      const stub = sinon.stub(global, 'setTimeout').callsFake((...args) => {
        const timer = setTimeout(...args)
        Reflect.set(timer, 'unref', unref)
        return timer
      })
      try {
        /** @type {Function} */
        let complete = notCaptured
        const handler = datadog((_event, _context, cb) => { complete = cb })
        handler({}, context, () => {})
        assert.strictEqual(clock.countTimers(), 1)
        complete(null, 'done')
        clock.tick(100)
        assert.strictEqual(clock.countTimers(), 0)
        assert.strictEqual(killAll.callCount, 0)
      } finally {
        stub.restore()
      }
    })
  }

  it('cleans up at runtime beforeExit completion and preserves the runtime callback contract', () => {
    const original = globalThis[BEFORE_EXIT] = sinon.stub().returns('runtime result')
    const receiver = {}
    const handler = datadog(() => undefined)
    handler({}, context)
    assert.strictEqual(clock.countTimers(), 1)
    assert.strictEqual(globalThis[BEFORE_EXIT].call(receiver, 'runtime argument'), 'runtime result')
    assert.strictEqual(globalThis[BEFORE_EXIT], original)
    assert.strictEqual(original.firstCall.thisValue, receiver)
    assert.deepStrictEqual(original.firstCall.args, ['runtime argument'])
    clock.tick(100)
    assert.strictEqual(clock.countTimers(), 0)
    assert.strictEqual(killAll.callCount, 0)
  })

  it('does not leak an idle invocation timer into the next warm invocation', () => {
    const handler = datadog(() => undefined)
    for (let invocation = 0; invocation < 3; invocation++) {
      globalThis[BEFORE_EXIT] = () => {}
      handler({}, context)
      assert.strictEqual(clock.countTimers(), 1)
      globalThis[BEFORE_EXIT]()
    }
    globalThis[BEFORE_EXIT] = () => {}
    handler({}, context)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1, 'only the still-pending invocation can time out')
    globalThis[BEFORE_EXIT]()
  })

  it('does not replace a newer runtime beforeExit callback when an earlier invocation completes', () => {
    globalThis[BEFORE_EXIT] = () => {}
    /** @type {Function} */
    let complete = notCaptured
    const handler = datadog((_event, _context, cb) => { complete = cb })
    handler({}, context, () => {})
    const replacement = globalThis[BEFORE_EXIT] = () => {}
    complete(null, 'done')
    assert.strictEqual(globalThis[BEFORE_EXIT], replacement)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('falls back to return cleanup when the runtime beforeExit callback cannot be wrapped', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, BEFORE_EXIT)
    Object.defineProperty(globalThis, BEFORE_EXIT, { value: () => {}, writable: false, configurable: true })
    try {
      const handler = datadog(() => undefined)
      assert.strictEqual(handler({}, context), undefined)
      clock.tick(100)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(killAll.callCount, 0)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, BEFORE_EXIT, descriptor)
      else delete globalThis[BEFORE_EXIT]
    }
  })

  it('keeps a pending callback monitored when the runtime beforeExit callback cannot be wrapped', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, BEFORE_EXIT)
    Object.defineProperty(globalThis, BEFORE_EXIT, { value: () => {}, writable: false, configurable: true })
    try {
      /** @type {Function} */
      let complete = notCaptured
      const handler = datadog((_event, _context, cb) => { complete = cb })
      handler({}, context, () => {})
      clock.tick(75)
      assert.strictEqual(killAll.callCount, 1)
      complete()
      assert.strictEqual(clock.countTimers(), 0)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, BEFORE_EXIT, descriptor)
      else delete globalThis[BEFORE_EXIT]
    }
  })

  it('monitors a rest-argument callback handler with a frozen context', () => {
    context.done = context.succeed = context.fail = () => {}
    Object.freeze(context)
    /** @type {Function} */
    let complete = notCaptured
    const result = {}
    const handler = datadog((...args) => {
      complete = args[2]
      return result
    })
    assert.strictEqual(handler({}, context, () => {}), result)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
    complete()
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const style of ['rest', 'default']) {
    for (const incidental of [{}, false]) {
      for (const outcome of ['success', 'error', 'timeout']) {
        it(`keeps a ${style} callback monitored after an incidental ${typeof incidental} return (${outcome})`, () => {
          delete globalThis[BEFORE_EXIT]
          const callback = sinon.spy()
          const error = outcome === 'error' ? new Error('callback failure') : null
          const schedule = cb => {
            setTimeout(() => cb(error, 'done'), outcome === 'timeout' ? 76 : 74)
            return incidental
          }
          const handlers = {
            rest: (...args) => schedule(args[2]),
            default: (_event, _context, cb = notCaptured) => schedule(cb),
          }
          const handler = datadog(handlers[style])
          assert.strictEqual(handler.length, style === 'rest' ? 0 : 2)
          assert.strictEqual(handler({}, context, callback), incidental)
          assert.strictEqual(clock.countTimers(), 2, 'keep both the monitor and the scheduled callback')
          clock.tick(74)
          assert.strictEqual(killAll.callCount, 0)
          assert.strictEqual(callback.callCount, outcome === 'timeout' ? 0 : 1)
          clock.tick(1)
          assert.strictEqual(killAll.callCount, outcome === 'timeout' ? 1 : 0)
          clock.tick(1)
          assert.strictEqual(callback.callCount, 1)
          assert.deepStrictEqual(callback.firstCall.args, [error, 'done'])
          assert.strictEqual(clock.countTimers(), 0)
        })
      }
    }
  }

  for (const behavior of ['ignore', 'throw on readback']) {
    it(`falls back when the runtime completion setter will ${behavior}`, () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, BEFORE_EXIT)
      let assigned = false
      const original = sinon.spy()
      Object.defineProperty(globalThis, BEFORE_EXIT, {
        configurable: true,
        get () {
          if (assigned && behavior === 'throw on readback') throw new Error('cannot verify wrapper')
          return original
        },
        set () { assigned = true },
      })
      try {
        const handler = datadog(() => undefined)
        handler({}, context)
        clock.tick(100)
        assert.strictEqual(clock.countTimers(), 0)
        assert.strictEqual(killAll.callCount, 0)
        assert.strictEqual(original.callCount, 0)
      } finally {
        if (descriptor) Object.defineProperty(globalThis, BEFORE_EXIT, descriptor)
        else delete globalThis[BEFORE_EXIT]
      }
    })
  }

  for (const protect of [Object.freeze, Object.seal, Object.preventExtensions]) {
    it(`monitors a ${protect.name} handler without modifying it`, () => {
      const original = protect((_event, _context, callback) => undefined)
      const descriptors = Object.getOwnPropertyDescriptors(original)
      const monitored = datadog(original)
      assert.strictEqual(monitored.length, 3)
      monitored({}, context, () => {})
      assert.strictEqual(clock.countTimers(), 1)
      clock.tick(75)
      assert.strictEqual(killAll.callCount, 1)
      assert.deepStrictEqual(span.addTags.firstCall.args, [{
        'error.message': 'Datadog detected an impending timeout',
        'error.type': 'Impending Timeout',
      }])
      assert.strictEqual(span.finish.callCount, 1)
      sinon.assert.callOrder(span.addTags, killAll, span.finish)
      assert.deepStrictEqual(Object.getOwnPropertyDescriptors(original), descriptors)
    })
  }

  it('preserves callback arity, receiver, arguments, and the raw return value', () => {
    const receiver = {}
    const event = {}
    const callbackReceiver = {}
    const callback = sinon.stub().returns('callback result')
    /** @type {Function} */
    let complete = notCaptured
    const handler = datadog(function (actualEvent, actualContext, cb) {
      assert.strictEqual(this, receiver)
      assert.strictEqual(actualEvent, event)
      assert.strictEqual(actualContext, context)
      complete = cb
      return 'incidental return'
    })

    assert.strictEqual(handler.length, 3)
    assert.strictEqual(handler.call(receiver, event, context, callback), 'incidental return')
    clock.tick(74)
    assert.strictEqual(killAll.callCount, 0)
    clock.tick(1)
    assert.strictEqual(killAll.callCount, 1, 'pending callback must remain monitored')
    assert.strictEqual(complete.call(callbackReceiver, null, 'done'), 'callback result')
    assert.strictEqual(callback.firstCall.thisValue, callbackReceiver)
    assert.deepStrictEqual(callback.firstCall.args, [null, 'done'])
  })

  for (const name of ['done', 'succeed', 'fail']) {
    for (const behavior of ['ignoring setter', 'lying Proxy', 'throwing readback']) {
      for (const withCallback of [false, true]) {
        it(`verifies context.${name} installation: ${behavior} (callback=${withCallback})`, () => {
          const original = sinon.stub().returns('completion result')
          let assigned = false
          if (behavior === 'lying Proxy') {
            context[name] = original
            context = new Proxy(context, {
              set: (target, key, value) => key === name || Reflect.set(target, key, value),
            })
          } else {
            Object.defineProperty(context, name, {
              get () {
                if (assigned && behavior === 'throwing readback') throw new Error('cannot verify wrapper')
                return original
              },
              set () { assigned = true },
            })
          }
          /** @type {Function} */
          let complete = notCaptured
          const handler = datadog((...args) => {
            complete = args[2]
            if (!withCallback && behavior !== 'throwing readback') {
              assert.strictEqual(context[name]('done'), 'completion result')
            }
          })
          handler({}, context, withCallback ? () => {} : undefined)
          assert.strictEqual(clock.countTimers(), withCallback ? 1 : 0)
          if (withCallback) complete()
          clock.tick(100)
          assert.strictEqual(clock.countTimers(), 0)
          assert.strictEqual(killAll.callCount, 0)
          if (!withCallback && behavior !== 'throwing readback') {
            assert.strictEqual(original.firstCall.thisValue, context)
            assert.deepStrictEqual(original.firstCall.args, ['done'])
          }
        })
      }
    }

    for (const outcome of ['timeout', 'success', 'error']) {
      it(`keeps callback completion observable with read-only context.${name} (${outcome})`, () => {
        Object.defineProperty(context, name, { value: () => {}, writable: false })
        /** @type {Function} */
        let complete = notCaptured
        const callback = sinon.spy()
        const handler = datadog((_event, _context, cb) => { complete = cb })
        assert.strictEqual(handler({}, context, callback), undefined)
        assert.strictEqual(clock.countTimers(), 1)
        if (outcome === 'timeout') {
          clock.tick(75)
          assert.strictEqual(killAll.callCount, 1)
          assert.strictEqual(span.addTags.firstCall.args[0]['error.type'], 'Impending Timeout')
        }
        const error = outcome === 'error' ? new Error('callback failure') : null
        complete(error, 'done')
        clock.tick(100)
        assert.strictEqual(killAll.callCount, outcome === 'timeout' ? 1 : 0)
        assert.strictEqual(clock.countTimers(), 0)
        assert.deepStrictEqual(callback.firstCall.args, [error, 'done'])
      })
    }

    it(`does not leave a timer armed when an unpatchable context.${name} completes`, () => {
      const original = context[name] = sinon.spy()
      Object.freeze(context)
      const handler = datadog((_event, ctx) => { ctx[name]('done') })
      assert.strictEqual(handler({}, context), undefined)
      assert.strictEqual(original.firstCall.thisValue, context)
      assert.deepStrictEqual(original.firstCall.args, ['done'])
      clock.tick(100)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(killAll.callCount, 0)
    })

    for (const protection of ['frozen', 'read-only', 'getter-only', 'throwing getter', 'throwing setter']) {
      it(`preserves handler execution with a ${protection} context.${name}`, async () => {
        const original = sinon.stub().returns('completion result')
        if (protection === 'frozen') {
          context[name] = original
          Object.freeze(context)
        } else if (protection === 'read-only') {
          Object.defineProperty(context, name, { value: original, writable: false })
        } else {
          Object.defineProperty(context, name, {
            get () {
              if (protection === 'throwing getter') throw new Error('cannot read completion method')
              return original
            },
            set: protection === 'throwing setter'
              ? () => { throw new Error('cannot set completion method') }
              : undefined,
          })
        }
        const handler = datadog((_event, ctx) => {
          assert.strictEqual(ctx, context)
          return Promise.resolve('done')
        })
        const result = handler({}, context)
        assert.strictEqual(clock.countTimers(), 1, 'promise completion must remain monitored')
        assert.strictEqual(await result, 'done')
        clock.tick(100)
        assert.strictEqual(killAll.callCount, 0)
        assert.strictEqual(clock.countTimers(), 0)
        assert.strictEqual(original.callCount, 0)
      })
    }

    for (const completion of ['return', 'throw', 'fulfill', 'reject', 'callback', 'context']) {
      it(`preserves ${completion} completion when the handler freezes context.${name}`, async () => {
        const original = context[name] = sinon.stub().returns('context result')
        const error = new Error('handler failure')
        const callback = sinon.stub().returns('callback result')
        const handlers = {
          return: () => 'done',
          throw: () => { throw error },
          fulfill: () => Promise.resolve('done'),
          reject: () => Promise.reject(error),
          callback: cb => cb(null, 'done'),
          context: () => context[name]('done'),
        }
        const handler = datadog(function (_event, ctx) {
          Object.freeze(ctx)
          return handlers[completion](arguments[2])
        })
        if (completion === 'throw') assert.throws(() => handler({}, context, callback), e => e === error)
        else if (completion === 'reject') await assert.rejects(handler({}, context, callback), e => e === error)
        else {
          const expected = { callback: 'callback result', context: 'context result' }[completion] ?? 'done'
          const result = handler({}, context, completion === 'return' ? undefined : callback)
          assert.strictEqual(await result, expected)
        }
        clock.tick(100)
        assert.strictEqual(killAll.callCount, 0)
        assert.strictEqual(clock.countTimers(), 0)
        if (completion === 'callback') assert.deepStrictEqual(callback.firstCall.args, [null, 'done'])
        if (completion === 'context') {
          assert.strictEqual(original.firstCall.thisValue, context)
          assert.deepStrictEqual(original.firstCall.args, ['done'])
        }
      })
    }

    it(`preserves completion if restoring context.${name} throws`, () => {
      let method = sinon.spy()
      let writable = true
      Object.defineProperty(context, name, {
        get: () => method,
        set (value) {
          if (!writable) throw new Error('cannot restore completion method')
          method = value
        },
      })
      const handler = datadog(() => {
        writable = false
        return 'done'
      })
      assert.strictEqual(handler({}, context), 'done')
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
    })

    for (const result of [undefined, new EventEmitter()]) {
      it(`keeps ${name} completion monitored after returning ${result ? 'an artifact' : 'undefined'}`, () => {
        const original = context[name] = sinon.stub().returns('completion result')
        const handler = datadog((_event, ctx) => result)
        assert.strictEqual(handler({}, context), result)
        const completion = context[name]
        clock.tick(75)
        assert.strictEqual(killAll.callCount, 1)
        assert.strictEqual(completion.call(context, 'finished'), 'completion result')
        assert.strictEqual(context[name], original, 'restore the context after completion')
        assert.strictEqual(original.firstCall.thisValue, context)
        assert.deepStrictEqual(original.firstCall.args, ['finished'])
      })
    }

    it(`cancels the timer when context.${name} completes`, () => {
      const original = context[name] = sinon.spy()
      const handler = datadog((_event, ctx) => { ctx[name]('done') })
      handler({}, context)
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(context[name], original)
    })
  }

  for (const error of [null, new Error('callback failure'), '', 0, false]) {
    it(`cancels the timer on callback completion with ${String(error)}`, () => {
      const callback = sinon.spy()
      /** @type {Function} */
      let complete = notCaptured
      const handler = datadog((_event, _context, cb) => { complete = cb })
      handler({}, context, callback)
      assert.strictEqual(clock.countTimers(), 1)
      complete(error, 'done')
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.deepStrictEqual(callback.firstCall.args, [error, 'done'])
    })
  }

  for (const result of [
    { listen () {}, close () {} },
    { on () {}, emit () {} },
    Object.create({ listen () {}, close () {} }),
    Object.create({ on () {}, emit () {} }),
    new (class Socket {})(),
  ]) {
    it(`keeps a ${result.constructor.name} side-effect artifact monitored until context completion`, () => {
      context.done = sinon.spy()
      const handler = datadog(() => result)
      assert.strictEqual(handler({}, context), result)
      assert.strictEqual(clock.countTimers(), 1)
      context.done()
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
    })
  }

  for (const name of ['listen', 'close', 'on', 'emit', 'constructor']) {
    for (const inherited of [false, true]) {
      it(`does not invoke an ${inherited ? 'inherited' : 'own'} ${name} getter on a sync result`, () => {
        context.done = () => {}
        const target = {}
        if (name === 'close') target.listen = () => {}
        if (name === 'emit') target.on = () => {}
        const getter = sinon.stub().throws(new Error('application getter must not run'))
        Object.defineProperty(target, name, { get: getter })
        const result = inherited ? Object.create(target) : target
        const handler = datadog(() => result)
        assert.strictEqual(handler({}, context), result)
        assert.strictEqual(getter.callCount, 0)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  it('does not invoke a constructor name getter or coerce a non-string constructor name', () => {
    context.done = () => {}
    const getter = sinon.stub().throws(new Error('constructor name must not run'))
    const toString = sinon.stub().throws(new Error('constructor name must not be coerced'))
    for (const constructor of [Object.defineProperty({}, 'name', { get: getter }), { name: { toString } }]) {
      const result = { constructor }
      const handler = datadog(() => result)
      assert.strictEqual(handler({}, context), result)
      assert.strictEqual(clock.countTimers(), 0)
    }
    assert.strictEqual(getter.callCount, 0)
    assert.strictEqual(toString.callCount, 0)
  })

  it('does not look through an accessor shadowing an inherited artifact method', () => {
    context.done = () => {}
    const result = Object.create({ listen () {}, close () {} })
    const getter = sinon.stub().returns(() => {})
    Object.defineProperty(result, 'listen', { get: getter })
    const handler = datadog(() => result)
    assert.strictEqual(handler({}, context), result)
    assert.strictEqual(getter.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('recognizes EventEmitter ancestry without evaluating overridden metadata', () => {
    const result = new EventEmitter()
    const getter = sinon.stub().throws(new Error('metadata getter must not run'))
    Object.defineProperties(result, {
      on: { get: getter },
      emit: { get: getter },
      constructor: { get: getter },
    })
    context.done = () => {}
    const handler = datadog(() => result)
    assert.strictEqual(handler({}, context), result)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
    context.done()
    assert.strictEqual(getter.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const inherited of [false, true]) {
    it(`does not inspect a ${inherited ? 'prototype' : 'result'} Proxy for side-effect artifact heuristics`, () => {
      context.done = () => {}
      const trap = sinon.stub().throws(new Error('reflection trap must not run'))
      const proxy = new Proxy({}, {
        get: (_target, name) => name === 'then' ? undefined : trap(),
        getPrototypeOf: trap,
        getOwnPropertyDescriptor: trap,
      })
      const result = inherited ? Object.create(proxy) : proxy
      const handler = datadog(() => result)
      assert.strictEqual(handler({}, context), result)
      assert.strictEqual(trap.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  for (const value of [null, false, 0, '', {}, Object.create(null)]) {
    it(`treats an ordinary ${value === null ? 'null' : typeof value} return as completion`, () => {
      context.done = () => {}
      const handler = datadog(() => value)
      assert.strictEqual(handler({}, context), value)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('does not overwrite a context method replaced by the handler', () => {
    context.done = sinon.spy()
    const replacement = sinon.spy()
    const handler = datadog((_event, ctx) => {
      ctx.done = replacement
      return 'done'
    })
    handler({}, context)
    assert.strictEqual(context.done, replacement)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const completion of ['return', 'throw', 'fulfill', 'reject']) {
    it(`clears the timer on ${completion}`, async () => {
      const error = new Error('handler failure')
      const handlers = {
        return: () => 'sync',
        throw: () => { throw error },
        fulfill: () => Promise.resolve('async'),
        reject: () => Promise.reject(error),
      }
      context.done = sinon.spy()
      const original = context.done
      const handler = datadog(handlers[completion])
      if (completion === 'throw') assert.throws(() => handler({}, context), e => e === error)
      else if (completion === 'reject') await assert.rejects(handler({}, context), e => e === error)
      else assert.strictEqual(await handler({}, context), completion === 'return' ? 'sync' : 'async')
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(context.done, original)
    })
  }

  it('does not let an earlier invocation clear a later invocation timer', async () => {
    /** @type {Function} */
    let resolveFirst = notCaptured
    /** @type {Function} */
    let resolveSecond = notCaptured
    const firstHandler = datadog(() => new Promise(resolve => { resolveFirst = resolve }))
    const secondHandler = datadog(() => new Promise(resolve => { resolveSecond = resolve }))
    const first = firstHandler({}, context)
    const second = secondHandler({}, context)
    assert.strictEqual(clock.countTimers(), 2)
    resolveFirst('first')
    await first
    resolveSecond('second')
    await second
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('clears the timer when invoking a thenable throws', () => {
    const error = new Error('thenable failure')
    const handler = datadog(() => ({ then () { throw error } }))
    assert.throws(() => handler({}, context), e => e === error)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const winner of ['callback', 'promise']) {
    it(`cleans up when the ${winner} wins a race and isolates late completion from a warm invocation`, async () => {
      /** @type {Function} */
      let complete = notCaptured
      /** @type {Function} */
      let resolvePromise = notCaptured
      const promise = new Promise(resolve => { resolvePromise = resolve })
      const handler = datadog((_event, _context, cb) => {
        complete = cb
        return promise
      })
      const result = handler({}, context, () => {})
      if (winner === 'callback') complete(null, 'callback')
      else { resolvePromise('promise'); await result }
      assert.strictEqual(clock.countTimers(), 0)

      /** @type {Function} */
      let nextComplete = notCaptured
      const next = datadog((_event, _context, cb) => { nextComplete = cb })
      next({}, context, () => {})
      if (winner === 'callback') {
        resolvePromise('late promise')
        await result
      } else {
        complete(null, 'late callback')
      }
      assert.strictEqual(clock.countTimers(), 1, 'late completion must not cancel the next timer')
      clock.tick(75)
      assert.strictEqual(killAll.callCount, 1)
      nextComplete()
    })
  }

  it('preserves streaming metadata and treats a sync streaming return as completion', () => {
    const stream = {}
    const original = function (event, responseStream, ctx) {
      assert.strictEqual(responseStream, stream)
      assert.strictEqual(ctx, context)
    }
    original[HANDLER_STREAMING] = 'response'
    const handler = datadog(original)
    assert.strictEqual(handler[HANDLER_STREAMING], 'response')
    assert.strictEqual(handler.length, 3)
    assert.strictEqual(handler({}, stream, context), undefined)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
  })

  for (const highWaterMark of [undefined, 0, 16384]) {
    it(`preserves streaming highWaterMark=${highWaterMark} on a frozen handler`, () => {
      const original = () => undefined
      original[HANDLER_STREAMING] = 'response'
      if (highWaterMark !== undefined) original[HANDLER_HIGHWATERMARK] = highWaterMark
      Object.freeze(original)
      const handler = datadog(original)
      assert.strictEqual(handler[HANDLER_STREAMING], 'response')
      assert.strictEqual(handler[HANDLER_HIGHWATERMARK], highWaterMark)
      assert.strictEqual(Object.hasOwn(handler, HANDLER_HIGHWATERMARK), highWaterMark !== undefined)
    })
  }

  for (const symbol of [HANDLER_STREAMING, HANDLER_HIGHWATERMARK]) {
    for (const inherited of [false, true]) {
      it(`does not invoke an ${inherited ? 'inherited' : 'own'} ${symbol.description} getter`, () => {
        const original = () => 'done'
        const target = inherited ? Object.create(Object.getPrototypeOf(original)) : original
        if (inherited) Object.setPrototypeOf(original, target)
        const getter = sinon.stub().throws(new Error('handler metadata getter must not run'))
        Object.defineProperty(target, symbol, { get: getter })
        const other = symbol === HANDLER_STREAMING ? HANDLER_HIGHWATERMARK : HANDLER_STREAMING
        const value = other === HANDLER_STREAMING ? 'response' : 0
        original[other] = value

        const handler = datadog(original)
        assert.strictEqual(Object.hasOwn(handler, symbol), false)
        assert.strictEqual(handler[other], value)
        context.done = () => {}
        const args = other === HANDLER_STREAMING ? [{}, {}, context] : [{}, context]
        assert.strictEqual(handler(...args), 'done')
        clock.tick(100)
        assert.strictEqual(getter.callCount, 0)
        assert.strictEqual(killAll.callCount, 0)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  it('preserves inherited streaming metadata on a frozen handler', () => {
    const original = () => undefined
    const prototype = Object.create(Function.prototype)
    prototype[HANDLER_STREAMING] = 'response'
    prototype[HANDLER_HIGHWATERMARK] = 0
    Object.setPrototypeOf(original, prototype)
    Object.freeze(original)

    const handler = datadog(original)
    assert.strictEqual(handler[HANDLER_STREAMING], 'response')
    assert.strictEqual(handler[HANDLER_HIGHWATERMARK], 0)
    context.done = () => {}
    assert.strictEqual(handler({}, {}, context), undefined)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const inherited of [false, true]) {
    it(`does not inspect a ${inherited ? 'prototype' : 'handler'} Proxy for handler metadata`, () => {
      const original = (_event, _context) => 'done'
      const target = inherited ? Object.create(Function.prototype) : original
      target[HANDLER_STREAMING] = 'response'
      target[HANDLER_HIGHWATERMARK] = 16384
      const trap = sinon.stub().throws(new Error('handler metadata trap must not run'))
      const proxy = new Proxy(target, {
        get (target, name, receiver) {
          if (name === 'length' || name === HANDLER_STREAMING || name === HANDLER_HIGHWATERMARK) return trap()
          return Reflect.get(target, name, receiver)
        },
        getOwnPropertyDescriptor: trap,
        getPrototypeOf: trap,
      })
      if (inherited) Object.setPrototypeOf(original, proxy)

      const handler = datadog(inherited ? original : proxy)
      assert.strictEqual(handler.length, inherited ? 2 : 0)
      assert.strictEqual(Object.hasOwn(handler, HANDLER_STREAMING), false)
      assert.strictEqual(Object.hasOwn(handler, HANDLER_HIGHWATERMARK), false)
      context.done = () => {}
      assert.strictEqual(handler({}, context), 'done')
      clock.tick(100)
      assert.strictEqual(trap.callCount, 0)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('does not invoke a handler length getter', () => {
    const original = () => 'done'
    const getter = sinon.stub().throws(new Error('handler length getter must not run'))
    Object.defineProperty(original, 'length', { get: getter })

    const handler = datadog(original)
    assert.strictEqual(handler.length, 0)
    context.done = () => {}
    assert.strictEqual(handler({}, context), 'done')
    clock.tick(100)
    assert.strictEqual(getter.callCount, 0)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('does not require a context or an initialized tracer', () => {
    const receiver = {}
    const handler = datadog(function () { return this })
    assert.strictEqual(handler.call(receiver), receiver)
    global._ddtrace = undefined
    assert.strictEqual(handler.call(receiver, {}, context), receiver)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('handles an already elapsed deadline', () => {
    context.getRemainingTimeInMillis = () => 10
    const handler = datadog(() => new Promise(() => {}))
    handler({}, context)
    clock.tick(0)
    assert.strictEqual(killAll.callCount, 1)
  })

  for (const invalid of [undefined, NaN, Infinity]) {
    it(`does not arm a timer for a non-finite remaining time (${invalid})`, () => {
      context.getRemainingTimeInMillis = () => invalid
      const handler = datadog(() => 'result')
      assert.strictEqual(handler({}, context), 'result')
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('flushes unfinished spans even when no invocation span is active', () => {
    span = null
    const handler = datadog(() => new Promise(() => {}))
    handler({}, context)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
  })
})
