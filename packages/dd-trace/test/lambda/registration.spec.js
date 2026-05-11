'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')

const proxyquire = require('proxyquire').noPreserveCache()

const instrumentations = require('../../../datadog-instrumentations/src/helpers/instrumentations')

const oldEnv = process.env

function loadLambdaWithHookSpy () {
  /** @type {Array<{ modules: string[], onrequire: Function }>} */
  const hookCalls = []
  /**
   * @param {string[]} modules
   * @param {Function} onrequire
   */
  const HookSpy = (modules, onrequire) => {
    hookCalls.push({ modules, onrequire })
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
      delete instrumentations['datadog-lambda-js']
    })

    it('registers a hook on the resolved handler file paths', () => {
      process.env.LAMBDA_TASK_ROOT = '/var/task'
      process.env.DD_LAMBDA_HANDLER = './api/src/index.nested.handler'

      const { hookCalls } = loadLambdaWithHookSpy()

      assert.strictEqual(hookCalls.length, 1)
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

      assert.strictEqual(hookCalls.length, 1)
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
