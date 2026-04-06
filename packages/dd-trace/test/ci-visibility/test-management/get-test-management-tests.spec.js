'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')

const {
  getTestManagementTests,
} = require('../../../src/ci-visibility/test-management/get-test-management-tests')
const {
  buildCacheKey,
  getCachePath,
  getLockPath,
} = require('../../../src/ci-visibility/requests/fs-cache')

const BASE_URL = 'http://localhost:8126'

const DEFAULT_PARAMS = {
  url: BASE_URL,
  isEvpProxy: false,
  evpProxyPrefix: '',
  isGzipCompatible: false,
  repositoryUrl: 'https://github.com/example/repo',
  commitMessage: 'fix tests',
  sha: 'abc123',
  commitHeadSha: '',
  commitHeadMessage: '',
  branch: 'main',
}

const TEST_MGMT_RESPONSE = {
  data: {
    attributes: {
      modules: {
        jest: {
          suites: {
            'suite1.spec.js': {
              tests: {
                'test one': { properties: { disabled: true } },
              },
            },
          },
        },
      },
    },
  },
}

function cacheKeyForParams (params) {
  const effectiveSha = params.commitHeadSha || params.sha
  return buildCacheKey('test-mgmt', [effectiveSha, params.repositoryUrl, params.branch])
}

function cleanup (params) {
  const key = cacheKeyForParams(params)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

describe('get-test-management-tests', () => {
  beforeEach(() => {
    process.env.DD_API_KEY = 'test-api-key'
    process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = 'true'
    cleanup(DEFAULT_PARAMS)
  })

  afterEach(() => {
    delete process.env.DD_API_KEY
    delete process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    cleanup(DEFAULT_PARAMS)
    nock.cleanAll()
  })

  it('should fetch from API and return test management tests', (done) => {
    nock(BASE_URL)
      .post('/api/v2/test/libraries/test-management/tests')
      .reply(200, JSON.stringify(TEST_MGMT_RESPONSE))

    getTestManagementTests(DEFAULT_PARAMS, (err, tests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(tests, TEST_MGMT_RESPONSE.data.attributes.modules)
      done()
    })
  })

  it('should return cached data on second call without hitting API', (done) => {
    const scope = nock(BASE_URL)
      .post('/api/v2/test/libraries/test-management/tests')
      .reply(200, JSON.stringify(TEST_MGMT_RESPONSE))

    getTestManagementTests(DEFAULT_PARAMS, (err, firstResult) => {
      assert.strictEqual(err, null)
      assert.ok(scope.isDone())

      const secondScope = nock(BASE_URL)
        .post('/api/v2/test/libraries/test-management/tests')
        .reply(200, JSON.stringify(TEST_MGMT_RESPONSE))

      getTestManagementTests(DEFAULT_PARAMS, (err, secondResult) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(secondResult, firstResult)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT have been called on cache hit')
        done()
      })
    })
  })

  it('should write cache and clean up lock after successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/test/libraries/test-management/tests')
      .reply(200, JSON.stringify(TEST_MGMT_RESPONSE))

    getTestManagementTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      assert.ok(fs.existsSync(getCachePath(key)), 'cache file should exist')
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up')
      done()
    })
  })
})
