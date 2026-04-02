'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')

const { getKnownTests } = require('../../../src/ci-visibility/early-flake-detection/get-known-tests')

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
}

const KNOWN_TESTS_RESPONSE = {
  data: {
    attributes: {
      tests: {
        jest: {
          'suite1.spec.js': ['test1', 'test2'],
          'suite2.spec.js': ['test3'],
        },
      },
    },
  },
}

function buildCacheKey (params) {
  const parts = [
    params.sha, params.service, params.env, params.repositoryUrl,
    params.osPlatform, params.osVersion, params.osArchitecture,
    params.runtimeName, params.runtimeVersion, JSON.stringify(params.custom ?? {}),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

function getCachePath (key) {
  return path.join(tmpdir(), `dd-known-tests-${key}.json`)
}

function getLockPath (key) {
  return path.join(tmpdir(), `dd-known-tests-${key}.lock`)
}

function cleanup (params) {
  const key = buildCacheKey(params)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

describe('get-known-tests', () => {
  beforeEach(() => {
    process.env.DD_API_KEY = 'test-api-key'
    cleanup(DEFAULT_PARAMS)
  })

  afterEach(() => {
    delete process.env.DD_API_KEY
    cleanup(DEFAULT_PARAMS)
    nock.cleanAll()
  })

  it('should fetch from API and return known tests', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err, knownTests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      done()
    })
  })

  it('should write to cache after a successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = buildCacheKey(DEFAULT_PARAMS)
      const cachePath = getCachePath(key)
      assert.ok(fs.existsSync(cachePath), 'cache file should exist')

      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      assert.deepStrictEqual(cached.knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      assert.ok(typeof cached.timestamp === 'number')
      done()
    })
  })

  it('should return cached data on second call without hitting API', (done) => {
    const scope = nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err, firstResult) => {
      assert.strictEqual(err, null)
      assert.ok(scope.isDone(), 'API should have been called')

      // Second call should NOT hit the API
      const secondScope = nock(BASE_URL)
        .post('/api/v2/ci/libraries/tests')
        .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

      getKnownTests(DEFAULT_PARAMS, (err, secondResult) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(secondResult, firstResult)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT have been called on cache hit')
        done()
      })
    })
  })

  it('should not use cache if TTL has expired', (done) => {
    // Write an expired cache entry
    const key = buildCacheKey(DEFAULT_PARAMS)
    const cachePath = getCachePath(key)
    const expiredData = {
      timestamp: Date.now() - (31 * 60 * 1000), // 31 minutes ago
      knownTests: { old: { suite: ['old-test'] } },
    }
    fs.writeFileSync(cachePath, JSON.stringify(expiredData), 'utf8')

    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err, knownTests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      done()
    })
  })

  it('should use different cache keys for different SHAs', (done) => {
    const scope1 = nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)
      assert.ok(scope1.isDone())

      const otherParams = { ...DEFAULT_PARAMS, sha: 'different-sha' }

      const scope2 = nock(BASE_URL)
        .post('/api/v2/ci/libraries/tests')
        .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

      getKnownTests(otherParams, (err) => {
        assert.strictEqual(err, null)
        assert.ok(scope2.isDone(), 'API should be called for a different SHA')
        cleanup(otherParams)
        done()
      })
    })
  })

  it('should handle API errors without caching', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'Internal Server Error')

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.ok(err)

      const key = buildCacheKey(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getCachePath(key)), false, 'cache should not be written on error')
      done()
    })
  })

  describe('lock contention', () => {
    it('should wait for cache when lock is held and cache appears', (done) => {
      const key = buildCacheKey(DEFAULT_PARAMS)
      const lockPath = getLockPath(key)

      // Simulate another process holding the lock
      fs.writeFileSync(lockPath, String(Date.now()))

      // Start a getKnownTests call that will wait for the lock
      getKnownTests(DEFAULT_PARAMS, (err, knownTests) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
        done()
      })

      // Simulate the lock holder writing the cache after a short delay
      setTimeout(() => {
        const cachePath = getCachePath(key)
        fs.writeFileSync(cachePath, JSON.stringify({
          timestamp: Date.now(),
          knownTests: KNOWN_TESTS_RESPONSE.data.attributes.tests,
        }), 'utf8')
      }, 600)
    })

    it('should fall back to direct fetch when lock is stale', function (done) {
      this.timeout(10_000)

      const key = buildCacheKey(DEFAULT_PARAMS)
      const lockPath = getLockPath(key)

      // Simulate a stale lock (timestamp far in the past)
      fs.writeFileSync(lockPath, String(Date.now() - 200_000))

      nock(BASE_URL)
        .post('/api/v2/ci/libraries/tests')
        .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

      getKnownTests(DEFAULT_PARAMS, (err, knownTests) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
        done()
      })
    })
  })

  it('should clean up lock after successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = buildCacheKey(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up')
      done()
    })
  })

  it('should clean up lock after failed fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'error')

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.ok(err)

      const key = buildCacheKey(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up on error')
      done()
    })
  })
})
