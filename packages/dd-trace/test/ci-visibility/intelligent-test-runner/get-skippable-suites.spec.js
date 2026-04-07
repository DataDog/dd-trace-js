'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')

const { getSkippableSuites } = require('../../../src/ci-visibility/intelligent-test-runner/get-skippable-suites')
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
  env: 'ci',
  service: 'my-service',
  repositoryUrl: 'https://github.com/example/repo',
  sha: 'abc123',
  osVersion: '22.04',
  osPlatform: 'linux',
  osArchitecture: 'x64',
  runtimeName: 'node',
  runtimeVersion: '18.0.0',
  custom: {},
  testLevel: 'suite',
}

const SKIPPABLE_RESPONSE = {
  data: [
    { type: 'suite', attributes: { suite: 'suite1.spec.js' } },
    { type: 'suite', attributes: { suite: 'suite2.spec.js' } },
  ],
  meta: { correlation_id: 'corr-123' },
}

function cacheKeyForParams (params) {
  return buildCacheKey('skippable', [
    params.sha, params.service, params.env, params.repositoryUrl,
    params.osPlatform, params.osVersion, params.osArchitecture,
    params.runtimeName, params.runtimeVersion, params.testLevel, params.custom,
  ])
}

function cleanup (params) {
  const key = cacheKeyForParams(params)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

describe('get-skippable-suites', () => {
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

  it('should fetch from API and return skippable suites with correlationId', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

    getSkippableSuites(DEFAULT_PARAMS, (err, skippableSuites, correlationId) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js', 'suite2.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      done()
    })
  })

  it('should return cached data on second call preserving correlationId', (done) => {
    const scope = nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

    getSkippableSuites(DEFAULT_PARAMS, (err, firstSuites, firstCorrelationId) => {
      assert.strictEqual(err, null)
      assert.ok(scope.isDone())

      const secondScope = nock(BASE_URL)
        .post('/api/v2/ci/tests/skippable')
        .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

      getSkippableSuites(DEFAULT_PARAMS, (err, secondSuites, secondCorrelationId) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(secondSuites, firstSuites)
        assert.strictEqual(secondCorrelationId, firstCorrelationId)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT have been called on cache hit')
        done()
      })
    })
  })

  it('should write cache and clean up lock after successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

    getSkippableSuites(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      assert.ok(fs.existsSync(getCachePath(key)), 'cache file should exist')
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up')
      done()
    })
  })
})
