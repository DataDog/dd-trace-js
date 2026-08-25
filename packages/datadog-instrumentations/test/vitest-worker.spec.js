'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()

describe('vitest worker instrumentation', () => {
  it('waits for log submission once at worker cleanup instead of after every suite', async () => {
    const hooks = []
    const logSubmissionFlushCh = channel('ci:log-submission:flush')
    const testSuiteFinishCh = { hasSubscribers: true }
    const realInstrument = require('../src/helpers/instrument')
    const realVitestUtil = require('../src/vitest-util')
    let cleanup
    let flushCalls = 0
    let resolveFlush
    const flushPromise = new Promise(resolve => {
      resolveFlush = resolve
    })

    proxyquire('../src/vitest-worker', {
      './helpers/channel': {
        getChannelPromise (currentChannel) {
          if (currentChannel === logSubmissionFlushCh) {
            flushCalls++
            return flushPromise
          }
          return Promise.resolve()
        },
      },
      './helpers/instrument': {
        ...realInstrument,
        addHook (target, hook) {
          hooks.push({ hook, target })
        },
      },
      './vitest-util': {
        ...realVitestUtil,
        getProvidedContext () {
          return { repositoryRoot: process.cwd() }
        },
        getTypeTasks () {
          return []
        },
        testSuiteFinishCh,
      },
    })

    const runnerHook = hooks.filter(({ target }) =>
      target.name === '@vitest/runner' && target.versions?.[0] === '>=1.6.0'
    ).at(-1).hook
    const vitestPackage = {
      async startTests () {
        return [{ result: { state: 'pass' }, tasks: [] }]
      },
    }
    runnerHook(vitestPackage, '4.1.11')

    const logSubmissionListener = () => {}
    logSubmissionFlushCh.subscribe(logSubmissionListener)
    try {
      const runner = {
        onCleanupWorkerContext (listener) {
          assert.strictEqual(cleanup, undefined)
          cleanup = listener
        },
      }

      await vitestPackage.startTests([{ filepath: '/tmp/first-test.mjs' }], runner)
      await vitestPackage.startTests([{ filepath: '/tmp/second-test.mjs' }], runner)
      await vitestPackage.startTests([{ filepath: '/tmp/legacy-test.mjs' }], {})

      assert.strictEqual(flushCalls, 0)
      assert.strictEqual(typeof cleanup, 'function')

      let cleanupCompleted = false
      const cleanupPromise = cleanup().then(() => {
        cleanupCompleted = true
      })
      await Promise.resolve()

      assert.strictEqual(cleanupCompleted, false)
      assert.strictEqual(flushCalls, 1)

      resolveFlush()
      await cleanupPromise
      assert.strictEqual(cleanupCompleted, true)

      testSuiteFinishCh.hasSubscribers = false
      let cleanupRegisteredWithoutTracing = false
      await vitestPackage.startTests([{ filepath: '/tmp/tracing-disabled-test.mjs' }], {
        onCleanupWorkerContext () {
          cleanupRegisteredWithoutTracing = true
        },
      })

      assert.strictEqual(cleanupRegisteredWithoutTracing, false)
      assert.strictEqual(flushCalls, 1)
    } finally {
      logSubmissionFlushCh.unsubscribe(logSubmissionListener)
    }
  })
})
