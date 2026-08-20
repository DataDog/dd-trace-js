'use strict'

const assert = require('node:assert/strict')
const nodeModule = require('node:module')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const agentlessFlushCh = channel('ci:agentless:flush')

describe('jest instrumentation', () => {
  let jestAdapterHook
  let jestRuntimeHook
  let jestTestWorkerHook
  let nativeRequire

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHook = sinon.spy()
    nativeRequire = sinon.stub()
    nativeRequire.cache = {}
    nativeRequire.resolve = sinon.stub()
    const previousWorkerId = process.env.JEST_WORKER_ID
    process.env.JEST_WORKER_ID = '1'

    try {
      proxyquire('../src/jest', {
        'node:module': { ...nodeModule, createRequire: () => nativeRequire },
        './helpers/instrument': { ...realInstrument, addHook },
      })
    } finally {
      if (previousWorkerId === undefined) {
        delete process.env.JEST_WORKER_ID
      } else {
        process.env.JEST_WORKER_ID = previousWorkerId
      }
    }

    const hookCall = addHook.getCalls().find(({ args }) =>
      args[0].name === 'jest-circus' &&
      args[0].file === 'build/legacy-code-todo-rewrite/jestAdapter.js'
    )
    jestAdapterHook = hookCall.args[1]

    const runtimeHookCall = addHook.getCalls().find(({ args }) => args[0].name === 'jest-runtime')
    jestRuntimeHook = runtimeHookCall.args[1]

    const testWorkerHookCall = addHook.getCalls().find(({ args }) =>
      args[0].name === 'jest-runner' && args[0].file === 'build/testWorker.js'
    )
    jestTestWorkerHook = testWorkerHookCall.args[1]
  })

  it('caches the instrumented native logger export in the Jest registry', () => {
    const from = '/test/suite.js'
    const modulePath = '/node_modules/pino/index.js'
    const instrumentedLogger = sinon.stub()
    const nativeModule = {
      children: [],
      exports: sinon.stub(),
      filename: modulePath,
    }

    nativeRequire.reset()
    nativeRequire.resolve.reset()
    nativeRequire.cache = {}
    nativeRequire.resolve.withArgs('pino').returns(modulePath)
    nativeRequire.callsFake(() => {
      nativeRequire.cache[modulePath] = nativeModule
      return instrumentedLogger
    })

    class Runtime {
      constructor () {
        this._moduleRegistry = new Map()
      }

      _resolveCjsModule () {
        return modulePath
      }

      requireModule () {}

      requireModuleOrMock () {}
    }

    jestRuntimeHook({ default: Runtime })
    const runtime = new Runtime()

    assert.strictEqual(runtime.requireModule(from, 'pino'), instrumentedLogger)
    assert.strictEqual(runtime.requireModule(from, 'pino'), instrumentedLogger)
    sinon.assert.calledOnce(nativeRequire)
    assert.strictEqual(runtime._moduleRegistry.get(modulePath).exports, instrumentedLogger)
  })

  it('defers the agentless flush until a multi-suite Jest worker tears down', async () => {
    const suiteResults = { numFailingTests: 0 }
    const wrappedAdapter = jestAdapterHook(sinon.stub().resolves(suiteResults), '29.7.0')
    const testWorker = jestTestWorkerHook({})
    let completeFlush
    let flushCount = 0
    const onFlush = ({ registerCompletion }) => {
      flushCount++
      completeFlush = registerCompletion()
    }
    agentlessFlushCh.subscribe(onFlush)

    try {
      for (const testSuiteAbsolutePath of ['/test/first.js', '/test/second.js']) {
        assert.strictEqual(await wrappedAdapter(undefined, undefined, {
          globalConfig: {},
          testEnvironmentOptions: {},
          testSuiteAbsolutePath,
        }), suiteResults)
      }
      assert.strictEqual(flushCount, 0)

      let settled = false
      const teardownPromise = testWorker.teardown().then(() => {
        settled = true
      })

      await new Promise(setImmediate)

      assert.strictEqual(flushCount, 1)
      assert.strictEqual(settled, false)
      completeFlush()
      await teardownPromise
      assert.strictEqual(settled, true)
    } finally {
      agentlessFlushCh.unsubscribe(onFlush)
    }
  })

  it('does not wait for the agentless flush before propagating Jest suite failures', async () => {
    const failure = new Error('boom')
    const wrappedAdapter = jestAdapterHook(sinon.stub().rejects(failure), '29.7.0')
    let flushCount = 0
    const onFlush = () => {
      flushCount++
    }
    agentlessFlushCh.subscribe(onFlush)

    try {
      await assert.rejects(wrappedAdapter(undefined, undefined, {
        globalConfig: {},
        testEnvironmentOptions: {},
        testSuiteAbsolutePath: '/test/suite.js',
      }), failure)
      assert.strictEqual(flushCount, 0)
    } finally {
      agentlessFlushCh.unsubscribe(onFlush)
    }
  })
})
