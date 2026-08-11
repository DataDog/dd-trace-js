'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const agentlessFlushCh = channel('ci:agentless:flush')

describe('jest instrumentation', () => {
  let jestAdapterHook

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHook = sinon.spy()
    const previousWorkerId = process.env.JEST_WORKER_ID
    process.env.JEST_WORKER_ID = '1'

    try {
      proxyquire('../src/jest', {
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
  })

  /**
   * @param {Function} adapter
   * @returns {Promise<{ result?: object, error?: Error }>}
   */
  async function finishAdapterAfterFlush (adapter) {
    const wrappedAdapter = jestAdapterHook(adapter, '29.7.0')
    let completeFlush
    const onFlush = ({ registerCompletion }) => {
      completeFlush = registerCompletion()
    }
    agentlessFlushCh.subscribe(onFlush)

    try {
      let settled = false
      const outcomePromise = wrappedAdapter(undefined, undefined, {
        globalConfig: {},
        testEnvironmentOptions: {},
        testSuiteAbsolutePath: '/test/suite.js',
      }).then(
        result => {
          settled = true
          return { result }
        },
        error => {
          settled = true
          return { error }
        }
      )

      await new Promise(setImmediate)

      assert.strictEqual(settled, false)
      completeFlush()
      return outcomePromise
    } finally {
      agentlessFlushCh.unsubscribe(onFlush)
    }
  }

  it('waits for the agentless flush in ordinary Jest workers', async () => {
    const suiteResults = { numFailingTests: 0 }
    const adapter = sinon.stub().resolves(suiteResults)

    assert.deepStrictEqual(await finishAdapterAfterFlush(adapter), { result: suiteResults })
  })

  it('waits for the agentless flush before propagating Jest worker failures', async () => {
    const failure = new Error('boom')
    const adapter = sinon.stub().rejects(failure)

    assert.deepStrictEqual(await finishAdapterAfterFlush(adapter), { error: failure })
  })
})
