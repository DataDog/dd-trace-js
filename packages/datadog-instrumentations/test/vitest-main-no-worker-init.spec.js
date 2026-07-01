'use strict'

const assert = require('node:assert/strict')

const noWorkerInit = require('../src/vitest-main-no-worker-init')

const VITEST_NO_WORKER_INIT_REQUEST_ENV = 'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT'
const workerPools = new Set(['forks', 'threads', 'vmForks', 'vmThreads'])
const options = {
  isVitestWorkerPool: pool => workerPools.has(pool),
}

describe('vitest-main-no-worker-init', () => {
  let originalRequested

  beforeEach(() => {
    originalRequested = process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]
    process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV] = 'true'
  })

  afterEach(() => {
    if (originalRequested === undefined) {
      delete process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]
    } else {
      process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV] = originalRequested
    }
  })

  describe('shouldUse', () => {
    it('rejects runs when the feature was not requested', () => {
      delete process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV]

      assert.strictEqual(noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.6', undefined, options), false)
    })

    it('rejects vitest versions older than 3.2.6', () => {
      assert.strictEqual(noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.5', undefined, options), false)
    })

    for (const pool of ['forks', 'threads']) {
      it(`accepts isolated ${pool} runs`, () => {
        assert.strictEqual(noWorkerInit.shouldUse({ config: { pool } }, '3.2.6', undefined, options), true)
      })
    }

    it('rejects root projects with isolate disabled', () => {
      assert.strictEqual(
        noWorkerInit.shouldUse({ config: { isolate: false, pool: 'forks' } }, '3.2.6', undefined, options),
        false
      )
    })

    it('rejects pool-specific isolate disabled configuration', () => {
      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            pool: 'threads',
            poolOptions: {
              threads: {
                isolate: false,
              },
            },
          },
        }, '3.2.6', undefined, options),
        false
      )
    })

    it('rejects selected test specifications with isolate disabled', () => {
      const project = {
        config: {
          isolate: false,
          pool: 'forks',
        },
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({ config: { pool: 'forks' } }, '3.2.6', [[project, { pool: 'forks' }]], options),
        false
      )
    })

    it('rejects mixed worker and non-worker selected test specifications', () => {
      const workerProject = {
        config: {
          pool: 'forks',
        },
      }
      const nonWorkerProject = {
        config: {
          pool: 'browser',
        },
      }

      assert.strictEqual(
        noWorkerInit.shouldUse({
          config: {
            pool: 'forks',
          },
        }, '3.2.6', [
          [workerProject, { pool: 'forks' }],
          [nonWorkerProject, { pool: 'browser' }],
        ], options),
        false
      )
    })
  })
})
