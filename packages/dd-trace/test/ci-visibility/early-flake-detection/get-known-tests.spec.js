'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const {
  getKnownTests,
  parseKnownTestsResponse,
} = require('../../../src/ci-visibility/early-flake-detection/get-known-tests')
const getConfig = require('../../../src/config')
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

const EMPTY_KNOWN_TESTS_RESPONSE = {
  data: {
    attributes: {
      tests: null,
    },
  },
}

function cacheKeyForParams (params) {
  return buildCacheKey('known-tests', [
    params.sha, params.service, params.env, params.repositoryUrl,
    params.osPlatform, params.osVersion, params.osArchitecture,
    params.runtimeName, params.runtimeVersion, params.custom,
  ])
}

function cleanup (params) {
  const key = cacheKeyForParams(params)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

describe('get-known-tests', () => {
  beforeEach(() => {
    process.env.DD_API_KEY = 'test-api-key'
    getConfig().DD_API_KEY = 'test-api-key'
    process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = 'true'
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = true
    cleanup(DEFAULT_PARAMS)
  })

  afterEach(() => {
    delete process.env.DD_API_KEY
    getConfig().DD_API_KEY = undefined
    delete process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = false
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

  it('does not fetch known tests without an API key', (done) => {
    getConfig().DD_API_KEY = undefined

    getKnownTests(DEFAULT_PARAMS, (error) => {
      assert.strictEqual(error.message, 'Known tests were not fetched because Datadog API key is not defined.')
      done()
    })
  })

  it('should write to cache after a successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      const cachePath = getCachePath(key)
      assert.ok(fs.existsSync(cachePath), 'cache file should exist')

      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      assert.deepStrictEqual(cached.data, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      assert.strictEqual(typeof cached.timestamp, 'number')
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

  it('should return cached empty known tests on second call without hitting API', (done) => {
    const scope = nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(EMPTY_KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err, firstResult) => {
      assert.strictEqual(err, null)
      assert.strictEqual(firstResult, null)
      assert.ok(scope.isDone(), 'API should have been called')

      const secondScope = nock(BASE_URL)
        .post('/api/v2/ci/libraries/tests')
        .reply(200, JSON.stringify(EMPTY_KNOWN_TESTS_RESPONSE))

      getKnownTests(DEFAULT_PARAMS, (err, secondResult) => {
        assert.strictEqual(err, null)
        assert.strictEqual(secondResult, null)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT have been called on cache hit')
        done()
      })
    })
  })

  it('should not use cache if TTL has expired', (done) => {
    // Write an expired cache entry
    const key = cacheKeyForParams(DEFAULT_PARAMS)
    const cachePath = getCachePath(key)
    const expiredData = {
      timestamp: Date.now() - (31 * 60 * 1000), // 31 minutes ago
      data: { old: { suite: ['old-test'] } },
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

  it('should handle API errors without caching', function (done) {
    this.timeout(15_000)

    // The request module retries 5xx once, so we need two replies
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'Internal Server Error')
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'Internal Server Error')

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.ok(err)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getCachePath(key)), false, 'cache should not be written on error')
      done()
    })
  })

  describe('lock contention', () => {
    it('should wait for cache when lock is held and cache appears', (done) => {
      const key = cacheKeyForParams(DEFAULT_PARAMS)
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
          data: KNOWN_TESTS_RESPONSE.data.attributes.tests,
        }), 'utf8')
      }, 600)
    })

    it('should fall back to direct fetch when lock is stale', function (done) {
      this.timeout(10_000)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
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

    it('should only fetch once when multiple callers observe a stale lock', function (done) {
      this.timeout(10_000)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      const lockPath = getLockPath(key)
      let numDoneCalls = 0

      fs.writeFileSync(lockPath, String(Date.now() - 200_000))

      const scope = nock(BASE_URL)
        .post('/api/v2/ci/libraries/tests')
        .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

      const onDone = (err, knownTests) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
        if (++numDoneCalls === 2) {
          assert.ok(scope.isDone(), 'API should have been called exactly once')
          done()
        }
      }

      getKnownTests(DEFAULT_PARAMS, onDone)
      getKnownTests(DEFAULT_PARAMS, onDone)
    })
  })

  it('should clean up lock after successful fetch', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up')
      done()
    })
  })

  it('should clean up lock after failed fetch', function (done) {
    this.timeout(15_000)

    // The request module retries 5xx once, so we need two replies
    nock(BASE_URL)
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'error')
      .post('/api/v2/ci/libraries/tests')
      .reply(500, 'error')

    getKnownTests(DEFAULT_PARAMS, (err) => {
      assert.ok(err)

      const key = cacheKeyForParams(DEFAULT_PARAMS)
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up on error')
      done()
    })
  })
})

describe('parseKnownTestsResponse', () => {
  it('returns tests from a raw backend response', () => {
    assert.deepStrictEqual(
      parseKnownTestsResponse(JSON.stringify(KNOWN_TESTS_RESPONSE)),
      KNOWN_TESTS_RESPONSE.data.attributes.tests
    )
  })

  it('preserves null tests from a raw backend response', () => {
    assert.strictEqual(parseKnownTestsResponse(JSON.stringify(EMPTY_KNOWN_TESTS_RESPONSE)), null)
  })

  it('validates known tests response shape when requested', () => {
    assert.deepStrictEqual(
      parseKnownTestsResponse(JSON.stringify(KNOWN_TESTS_RESPONSE), { validateRequiredFields: true }),
      KNOWN_TESTS_RESPONSE.data.attributes.tests
    )
    assert.throws(
      () => parseKnownTestsResponse(JSON.stringify({ data: { attributes: {} } }), { validateRequiredFields: true }),
      /Invalid known tests response: missing tests/
    )
    assert.throws(
      () => parseKnownTestsResponse(
        JSON.stringify({ data: { attributes: { tests: { jest: { 'suite.js': 'test' } } } } }),
        { validateRequiredFields: true }
      ),
      /Invalid known tests response: suite tests must be arrays/
    )
  })
})

describe('known-tests pagination telemetry', () => {
  let clock
  let fetchKnownTests
  let request
  let distributionMetric
  let writeToCache

  const metricNames = [
    'known_tests.pages_fetched',
    'known_tests.total_fetch_ms',
    'known_tests.total_request_ms',
  ]

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['performance'] })
    request = sinon.stub()
    distributionMetric = sinon.spy()
    writeToCache = sinon.spy()
    fetchKnownTests = proxyquire('../../../src/ci-visibility/early-flake-detection/get-known-tests', {
      'node:perf_hooks': { performance: { now: () => clock.now } },
      '../../config': () => ({ DD_API_KEY: 'test-api-key' }),
      '../../ci-visibility/telemetry': { distributionMetric },
      '../../plugins/util/test': {
        getNumFromKnownTests: () => {
          clock.tick(11)
          return 1
        },
      },
      '../requests/request': request,
      '../requests/fs-cache': {
        withCache: (key, fetch, done) => fetch(key, done),
        writeToCache,
      },
    }).getKnownTests
    const parse = JSON.parse
    sinon.stub(JSON, 'parse').callsFake((...args) => {
      clock.tick(7)
      return parse(...args)
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function reply (pageInfo) {
    return (data, options, callback) => {
      clock.tick(5)
      callback(null, JSON.stringify({
        data: { attributes: { tests: { jest: { suite: ['test'] } }, page_info: pageInfo } },
      }), 200)
    }
  }

  function summary () {
    return distributionMetric.getCalls()
      .filter(call => metricNames.includes(call.args[0]))
      .map(call => call.args)
  }

  it('reports one completed page with request time excluding local processing', (done) => {
    request.callsFake(reply())
    fetchKnownTests(DEFAULT_PARAMS, (err) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(summary(), [
        ['known_tests.pages_fetched', {}, 1],
        ['known_tests.total_fetch_ms', {}, 23],
        ['known_tests.total_request_ms', {}, 5],
      ])
      sinon.assert.calledOnce(writeToCache)
      done()
    })
  })

  it('sums completed pages and forwards the continuation cursor', (done) => {
    request.onFirstCall().callsFake(reply({ has_next: true, cursor: 'second' }))
    request.onSecondCall().callsFake(reply({ has_next: false }))
    fetchKnownTests(DEFAULT_PARAMS, (err, tests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(tests, { jest: { suite: ['test', 'test'] } })
      const secondRequest = JSON.parse(request.secondCall.args[0])
      assert.deepStrictEqual(secondRequest.data.attributes.page_info, { page_state: 'second' })
      assert.deepStrictEqual(summary(), [
        ['known_tests.pages_fetched', {}, 2],
        ['known_tests.total_fetch_ms', {}, 35],
        ['known_tests.total_request_ms', {}, 10],
      ])
      done()
    })
  })

  for (const [failure, failedPage] of [
    ['transport', 0], ['invalid JSON', 0], ['missing cursor', 0],
    ['transport', 1], ['invalid JSON', 1], ['missing cursor', 1],
  ]) {
    it(`omits completion metrics and cached partial results on page ${failedPage + 1} ${failure}`, (done) => {
      request.onFirstCall().callsFake(reply({ has_next: true, cursor: 'second' }))
      request.onCall(failedPage).callsFake((data, options, callback) => {
        clock.tick(5)
        if (failure === 'transport') return callback(new Error('connection reset'))
        if (failure === 'invalid JSON') return callback(null, '{invalid', 200)
        const replyWithoutCursor = reply({ has_next: true })
        replyWithoutCursor(data, options, callback)
      })
      fetchKnownTests(DEFAULT_PARAMS, (err) => {
        assert.ok(err)
        assert.deepStrictEqual(summary(), [])
        sinon.assert.notCalled(writeToCache)
        done()
      })
    })
  }

  it('counts a successful empty response as one fetched page', (done) => {
    request.callsFake((data, options, callback) => {
      clock.tick(5)
      callback(null, JSON.stringify({ data: { attributes: { tests: null } } }), 200)
    })
    fetchKnownTests(DEFAULT_PARAMS, (err, tests) => {
      assert.strictEqual(err, null)
      assert.strictEqual(tests, null)
      assert.deepStrictEqual(summary(), [
        ['known_tests.pages_fetched', {}, 1],
        ['known_tests.total_fetch_ms', {}, 23],
        ['known_tests.total_request_ms', {}, 5],
      ])
      done()
    })
  })

  it('does not report a fetched page for a cache hit', (done) => {
    const cachedTests = { jest: { suite: ['cached'] } }
    const cachedFetch = proxyquire('../../../src/ci-visibility/early-flake-detection/get-known-tests', {
      '../../ci-visibility/telemetry': { distributionMetric },
      '../requests/request': request,
      '../requests/fs-cache': { withCache: (key, fetch, callback) => callback(null, cachedTests) },
    }).getKnownTests
    cachedFetch(DEFAULT_PARAMS, (err, tests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(tests, cachedTests)
      sinon.assert.notCalled(request)
      assert.deepStrictEqual(summary(), [])
      done()
    })
  })
})
