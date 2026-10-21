'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const instrumentations = require('../../../datadog-instrumentations/src/helpers/instrumentations')
const log = require('../../src/log')

const oldEnv = process.env
const hookedModules = new Set()

function loadLambdaWithHookSpy () {
  /** @type {Array<{ modules: string[], onrequire: Function }>} */
  const hookCalls = []
  /**
   * @param {string[]} modules
   * @param {Function} onrequire
   */
  const HookSpy = (modules, onrequire) => {
    hookCalls.push({ modules, onrequire })
    for (const name of modules) hookedModules.add(name)
  }
  proxyquire('../../src/lambda', {
    '../../../datadog-instrumentations/src/helpers/hook': HookSpy,
  })
  return { hookCalls }
}

describe('lambda', () => {
  describe('registerLambdaHook', () => {
    beforeEach(() => {
      process.env = { ...oldEnv }
      delete process.env.DD_LAMBDA_HANDLER
      delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      // Drop cached `runtime/patch` so its module-level `addHook` calls run
      // against the test's current env (each test sets its own
      // `DD_LAMBDA_HANDLER`).
      delete require.cache[require.resolve('../../src/lambda/runtime/patch')]
    })

    afterEach(() => {
      process.env = oldEnv
      for (const name of hookedModules) delete instrumentations[name]
      hookedModules.clear()
    })

    it('registers a hook on the resolved handler file paths', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = './api/src/index.nested.handler'

      const { hookCalls } = loadLambdaWithHookSpy()

      assert.strictEqual(hookCalls.length, 2)
      assert.deepStrictEqual(hookCalls[1].modules, ['datadog-lambda-js'])
      const indexPath = path.resolve('/var/task', './api/src/', 'index')
      assert.deepStrictEqual(hookCalls[0].modules, [
        `${indexPath}.js`,
        `${indexPath}.mjs`,
        `${indexPath}.cjs`,
      ])
      assert.strictEqual(typeof hookCalls[0].onrequire, 'function')
    })

    it('registers a hook for a flat handler path', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'

      const { hookCalls } = loadLambdaWithHookSpy()

      assert.strictEqual(hookCalls.length, 2)
      const handlerPath = path.resolve('/var/task', '', 'handler')
      assert.deepStrictEqual(hookCalls[0].modules, [
        `${handlerPath}.js`,
        `${handlerPath}.mjs`,
        `${handlerPath}.cjs`,
      ])
    })

    it('falls back to the datadog-lambda-js branch when DD_LAMBDA_HANDLER is unset', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'

      const { hookCalls } = loadLambdaWithHookSpy()

      assert.strictEqual(hookCalls.length, 1)
      assert.deepStrictEqual(hookCalls[0].modules, ['datadog-lambda-js'])
    })

    it('throws when DD_LAMBDA_HANDLER is malformed', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = 'handler'

      assert.throws(loadLambdaWithHookSpy, { message: 'Malformed handler name: handler' })
    })

    it('does not register a hook when lambda is in DD_TRACE_DISABLED_INSTRUMENTATIONS', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'http,lambda,fs'

      const { hookCalls } = loadLambdaWithHookSpy()

      assert.strictEqual(hookCalls.length, 0)
    })

    it('wraps the registered handler key when the lambda Hook callback fires', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'

      const { hookCalls } = loadLambdaWithHookSpy()
      const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`

      const userHandler = () => 'original'
      const fakeModule = { myEntry: userHandler }
      hookCalls[0].onrequire(fakeModule, fixturePath, undefined, '0.0.0')

      assert.notStrictEqual(fakeModule.myEntry, userHandler)
      delete instrumentations[fixturePath]
    })

    for (const kind of ['function', 'arrow', 'frozen']) {
      it(`preserves safe own data properties on a ${kind} raw handler`, () => {
        process.env.LAMBDA_TASK_ROOT = '/var/task'
        process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'
        const { hookCalls } = loadLambdaWithHookSpy()
        const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
        const config = { enabled: true }
        const helper = value => value + 1
        const userHandler = kind === 'arrow' ? () => config : function () { return config }
        const symbol = Symbol('handler data')
        const getter = sinon.stub().throws(new Error('handler accessor must not run'))
        Object.defineProperties(userHandler, {
          config: { value: config, enumerable: true },
          helper: { value: helper, configurable: true, writable: true, enumerable: true },
          hidden: { value: config, configurable: true },
          settings: { get: getter, configurable: true, enumerable: true },
          [symbol]: { value: config, configurable: true },
        })
        Object.defineProperty(userHandler, '__proto__', { value: config, configurable: true, enumerable: true })
        if (kind === 'arrow') {
          Object.defineProperty(userHandler, 'prototype', { value: config, configurable: true, writable: true })
        }
        if (kind === 'frozen') Object.freeze(userHandler)

        try {
          const app = hookCalls[0].onrequire({ myEntry: userHandler }, fixturePath, undefined, '0.0.0')
          assert.notStrictEqual(app.myEntry, userHandler)
          for (const key of ['config', 'helper', 'hidden', '__proto__', symbol]) {
            assert.deepStrictEqual(Object.getOwnPropertyDescriptor(app.myEntry, key),
              Object.getOwnPropertyDescriptor(userHandler, key))
          }
          assert.strictEqual(app.myEntry.prototype, userHandler.prototype)
          assert.strictEqual(app.myEntry.config, config)
          assert.strictEqual(app.myEntry.helper(1), 2)
          assert.strictEqual(app.myEntry(), config)
          assert.strictEqual(Object.hasOwn(app.myEntry, 'settings'), false)
          sinon.assert.notCalled(getter)
        } finally {
          delete instrumentations[fixturePath]
        }
      })
    }

    for (const proxied of [false, true]) {
      for (const pending of [false, true]) {
        it(`monitors a ${pending ? 'pending' : 'completed'} native ESM ${proxied ? 'Proxy ' : ''}handler`, async () => {
          process.env.LAMBDA_TASK_ROOT = '/var/task'
          process.env.DD_LAMBDA_HANDLER = 'handler.handler'
          const { hookCalls } = loadLambdaWithHookSpy()
          const fixturePath = `${path.resolve('/var/task', '', 'handler')}.mjs`
          const source = `
            const raw = function (event, context) {
              if (event.error) throw event.error
              return event.pending ? new Promise(() => {}) : event.result
            }
            raw.config = { enabled: true }
            Object.defineProperty(raw, Symbol.for('aws.lambda.runtime.handler.streaming'), {
              get () { throw new Error('streaming accessor must not run') }
            })
            const fail = () => { throw new Error('Proxy trap must not run') }
            export let handler = raw
            export function wrapProxy () {
              handler = new Proxy(raw, {
                get: fail, ownKeys: fail, getOwnPropertyDescriptor: fail, getPrototypeOf: fail
              })
            }
            export const other = { preserved: true }
          `
          const namespace = await import(`data:text/javascript,${encodeURIComponent(source)}`)
          if (proxied) namespace.wrapProxy()
          const descriptor = Object.getOwnPropertyDescriptor(namespace, 'handler')
          assert.strictEqual(descriptor.configurable, false)
          assert.strictEqual(descriptor.writable, true)
          const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          const oldTracer = global._ddtrace
          const killAll = sinon.spy()
          const error = sinon.spy(log, 'error')
          global._ddtrace = {
            _tracer: {
              _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 },
              _processor: { killAll },
              scope: () => ({ active: () => null }),
            },
          }

          try {
            const app = hookCalls[0].onrequire(namespace, fixturePath, undefined, '0.0.0')
            assert.strictEqual(app === namespace, false, 'native namespace needs replacement exports')
            assert.notStrictEqual(app.handler, descriptor.value)
            assert.strictEqual(namespace.handler, descriptor.value)
            assert.strictEqual(app.other, namespace.other)
            assert.deepStrictEqual(Object.keys(app), Object.keys(namespace))
            assert.strictEqual(app.handler[Symbol.for('aws.lambda.runtime.handler.streaming')], undefined)
            if (!proxied) assert.strictEqual(app.handler.config, namespace.handler.config)
            const result = { ok: true }
            const invocation = app.handler({ pending, result }, { getRemainingTimeInMillis: () => 100 })
            assert.strictEqual(clock.countTimers(), pending ? 1 : 0)
            clock.tick(75)
            assert.strictEqual(killAll.callCount, pending ? 1 : 0)
            if (!pending) assert.strictEqual(invocation, result)
            const failure = new Error('user handler failure')
            assert.throws(() => app.handler({ error: failure }, { getRemainingTimeInMillis: () => 100 }),
              candidate => candidate === failure)
            assert.strictEqual(clock.countTimers(), 0)
            sinon.assert.notCalled(error)
          } finally {
            clock.restore()
            global._ddtrace = oldTracer
            error.restore()
            delete instrumentations[fixturePath]
          }
        })
      }
    }

    for (const configurable of [false, true]) {
      for (const writable of [false, true]) {
        it(`respects raw handler export descriptors (configurable=${configurable}, writable=${writable})`, () => {
          process.env.LAMBDA_TASK_ROOT = '/var/task'
          process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'
          const { hookCalls } = loadLambdaWithHookSpy()
          const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
          const userHandler = () => 'original'
          const fakeModule = {}
          Object.defineProperty(fakeModule, 'myEntry', { value: userHandler, configurable, writable })
          if (!configurable && !writable) Object.freeze(fakeModule)
          const error = sinon.spy(log, 'error')

          try {
            const patchedModule = hookCalls[0].onrequire(fakeModule, fixturePath, undefined, '0.0.0')
            assert.strictEqual(patchedModule, fakeModule)
            assert.strictEqual(patchedModule.myEntry === userHandler, !configurable && !writable)
            assert.strictEqual(patchedModule.myEntry(), 'original')
            const descriptor = Object.getOwnPropertyDescriptor(patchedModule, 'myEntry')
            assert.strictEqual(descriptor.configurable, configurable)
            assert.strictEqual(descriptor.writable, writable)
            sinon.assert.notCalled(error)
          } finally {
            error.restore()
            delete instrumentations[fixturePath]
          }
        })
      }
    }

    for (const symbol of [
      Symbol.for('aws.lambda.runtime.handler.streaming'),
      Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark'),
    ]) {
      for (const inherited of [false, true]) {
        for (const asynchronous of [false, true]) {
          const placement = inherited ? 'inherited' : 'own'
          const kind = asynchronous ? 'async' : 'sync'
          it(`does not restore an ${placement} ${symbol.description} getter on a ${kind} handler`, async () => {
            process.env.LAMBDA_TASK_ROOT = '/var/task'
            process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'
            const { hookCalls } = loadLambdaWithHookSpy()
            const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
            const userHandler = asynchronous ? async () => 'original' : () => 'original'
            const target = inherited ? Object.create(Object.getPrototypeOf(userHandler)) : userHandler
            if (inherited) Object.setPrototypeOf(userHandler, target)
            Object.defineProperty(target, symbol, {
              get () { throw new Error('handler metadata getter must not run') },
            })

            try {
              const fakeModule = { myEntry: userHandler }
              const patchedModule = hookCalls[0].onrequire(fakeModule, fixturePath, undefined, '0.0.0')
              assert.notStrictEqual(patchedModule.myEntry, userHandler)
              // The Lambda shim reads these properties after the tracer's module hook has returned.
              assert.strictEqual(patchedModule.myEntry[symbol], undefined)
              assert.strictEqual(await patchedModule.myEntry({}, {}), 'original')
            } finally {
              delete instrumentations[fixturePath]
            }
          })
        }
      }
    }

    for (const inherited of [false, true]) {
      it(`preserves ${inherited ? 'inherited' : 'own'} frozen streaming metadata through the module hook`, () => {
        process.env.LAMBDA_TASK_ROOT = '/var/task'
        process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'
        const { hookCalls } = loadLambdaWithHookSpy()
        const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
        const userHandler = function (event, responseStream, context) { return context }
        const target = inherited ? Object.create(Function.prototype) : userHandler
        if (inherited) Object.setPrototypeOf(userHandler, target)
        const streaming = Symbol.for('aws.lambda.runtime.handler.streaming')
        const highWaterMark = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
        Object.defineProperties(target, {
          [streaming]: { value: 'response' },
          [highWaterMark]: { value: 0 },
        })
        Object.freeze(userHandler)

        try {
          const fakeModule = { myEntry: userHandler }
          const patchedModule = hookCalls[0].onrequire(fakeModule, fixturePath, undefined, '0.0.0')
          assert.notStrictEqual(patchedModule.myEntry, userHandler)
          assert.strictEqual(patchedModule.myEntry[streaming], 'response')
          assert.strictEqual(patchedModule.myEntry[highWaterMark], 0)
          assert.strictEqual(patchedModule.myEntry.length, 3)
          const context = {}
          assert.strictEqual(patchedModule.myEntry({}, {}, context), context)
        } finally {
          delete instrumentations[fixturePath]
        }
      })
    }

    it('wraps the datadog export when the datadog-lambda-js Hook callback fires', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'

      const { hookCalls } = loadLambdaWithHookSpy()

      const datadogOriginal = handler => handler
      const fakeModule = { datadog: datadogOriginal }
      hookCalls[0].onrequire(fakeModule, 'datadog-lambda-js', undefined, '0.0.0')

      assert.notStrictEqual(fakeModule.datadog, datadogOriginal)
      // Exercise the inner wrapper produced by `patchDatadogLambdaHandler`.
      assert.strictEqual(typeof fakeModule.datadog(() => 'user'), 'function')
    })

    for (const file of ['dist/utils/handler.js', 'utils/handler.js']) {
      for (const pending of [false, true]) {
        it(`${pending ? 'monitors pending' : 'clears completed'} shim invocations through ${file}`, async () => {
          process.env.LAMBDA_TASK_ROOT = '/var/task'
          process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'
          const { hookCalls } = loadLambdaWithHookSpy()
          const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
          const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
          const oldTracer = global._ddtrace
          const killAll = sinon.spy()
          global._ddtrace = {
            _tracer: {
              _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 },
              _processor: { killAll },
              scope: () => ({ active: () => null }),
            },
          }

          try {
            const app = { myEntry: (_event, _context) => ({ ok: true }) }
            hookCalls[0].onrequire(app, fixturePath, undefined, '0.0.0')
            let complete
            const completion = new Promise(resolve => { complete = resolve })
            const moduleExports = {
              promisifiedHandler: handler => (event, context) => {
                handler(event, context, () => {})
                return completion
              },
            }
            const original = moduleExports.promisifiedHandler
            hookCalls[1].onrequire(moduleExports, `datadog-lambda-js/${file}`, undefined, '12.143.0')
            assert.notStrictEqual(moduleExports.promisifiedHandler, original)
            const handler = moduleExports.promisifiedHandler(app.myEntry)
            const invocation = handler({}, { getRemainingTimeInMillis: () => 100 })
            assert.strictEqual(clock.countTimers(), 1)
            if (pending) {
              clock.tick(74)
              assert.strictEqual(killAll.callCount, 0)
              clock.tick(1)
              assert.strictEqual(killAll.callCount, 1)
            }
            complete({ ok: true })
            assert.deepStrictEqual(await invocation, { ok: true })
            assert.strictEqual(clock.countTimers(), 0)
            clock.tick(100)
            assert.strictEqual(killAll.callCount, pending ? 1 : 0)
          } finally {
            clock.restore()
            global._ddtrace = oldTracer
            delete instrumentations[fixturePath]
          }
        })
      }
    }

    it('logs hook errors without unwinding the loop', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = 'handler.myEntry'

      const { hookCalls } = loadLambdaWithHookSpy()

      const fixturePath = `${path.resolve('/var/task', '', 'handler')}.js`
      // Replace whatever `runtime/patch` populated with two hooks: one that
      // throws (covers the catch / log branch) and one that returns a real
      // module object so the loop reaches the trailing return.
      instrumentations[fixturePath] = [
        { hook: () => { throw new Error('boom') } },
        { hook: mod => ({ ...mod, ok: true }) },
      ]

      const result = hookCalls[0].onrequire({}, fixturePath, undefined, '0.0.0')
      assert.strictEqual(result.ok, true)

      delete instrumentations[fixturePath]
    })

    it('logs datadog-lambda-js hook errors without unwinding the loop', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'

      const { hookCalls } = loadLambdaWithHookSpy()

      // `file: undefined` so `filename('datadog-lambda-js', file)` resolves to
      // the bare name and matches the `moduleName === fullFilename` branch.
      instrumentations['datadog-lambda-js'] = [
        { hook: () => { throw new Error('boom') }, file: undefined },
        { hook: mod => ({ ...mod, ok: true }), file: undefined },
        // A non-matching entry to exercise the `false` branch of the inner if.
        { hook: () => assert.fail('non-matching entry must not run'), file: 'other.js' },
      ]

      const result = hookCalls[0].onrequire({}, 'datadog-lambda-js', undefined, '0.0.0')
      assert.strictEqual(result.ok, true)
    })
  })
})
