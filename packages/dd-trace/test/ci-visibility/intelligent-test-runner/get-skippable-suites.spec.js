'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../../setup/core')

const {
  getSkippableSuites,
  parseSkippableSuitesResponse,
} = require('../../../src/ci-visibility/intelligent-test-runner/get-skippable-suites')
const getConfig = require('../../../src/config')
const {
  buildCacheKey,
  getCachePath,
  getLockPath,
} = require('../../../src/ci-visibility/requests/fs-cache')
const log = require('../../../src/log')

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

const SKIPPABLE_RESPONSE_WITH_COVERAGE = {
  data: [
    {
      type: 'suite',
      attributes: {
        suite: 'suite1.spec.js',
      },
    },
    {
      type: 'suite',
      attributes: {
        suite: 'suite2.spec.js',
      },
    },
  ],
  meta: {
    correlation_id: 'corr-123',
    coverage: {
      'src/file1.js': 'gA==',
      'src/file2.js': 'IA==',
    },
  },
}

const SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE = {
  data: [
    {
      type: 'suite',
      attributes: {
        suite: 'suite1.spec.js',
        _is_missing_line_code_coverage: true,
      },
    },
    {
      type: 'suite',
      attributes: {
        suite: 'suite2.spec.js',
        _is_missing_line_code_coverage: false,
      },
    },
  ],
  meta: {
    correlation_id: 'corr-123',
    coverage: {
      'src/file1.js': 'gA==',
    },
  },
}

const SKIPPABLE_RESPONSE_WITH_ALL_MISSING_LINE_COVERAGE = {
  ...SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE,
  data: SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE.data.map(item => ({
    ...item,
    attributes: {
      ...item.attributes,
      _is_missing_line_code_coverage: true,
    },
  })),
}

function cacheKeyForParams (params) {
  return buildCacheKey('skippable', [
    params.sha, params.service, params.env, params.repositoryUrl,
    params.osPlatform, params.osVersion, params.osArchitecture,
    params.runtimeName, params.runtimeVersion, params.testLevel, params.custom,
    params.isCoverageReportUploadEnabled || false,
  ])
}

function cleanup (params) {
  const key = cacheKeyForParams(params)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

describe('get-skippable-suites', () => {
  beforeEach(() => {
    sinon.spy(log, 'debug')
    sinon.spy(log, 'warn')
    process.env.DD_API_KEY = 'test-api-key'
    getConfig().DD_API_KEY = 'test-api-key'
    process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = 'true'
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = true
    cleanup(DEFAULT_PARAMS)
    cleanup({ ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true })
  })

  afterEach(() => {
    sinon.restore()
    delete process.env.DD_API_KEY
    getConfig().DD_API_KEY = undefined
    delete process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = false
    cleanup(DEFAULT_PARAMS)
    cleanup({ ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true })
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

  it('should return a request error for malformed skippable suites', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify({
        data: [{ type: 'suite', attributes: {} }],
      }))

    getSkippableSuites(DEFAULT_PARAMS, (err, skippableSuites) => {
      assert.match(err.message, /Invalid skippable tests response: data entry suite must be a string/)
      assert.strictEqual(skippableSuites, undefined)
      done()
    })
  })

  it('should return skippable suite coverage from response metadata', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE_WITH_COVERAGE))

    getSkippableSuites(DEFAULT_PARAMS, (err, skippableSuites, correlationId, coverage) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js', 'suite2.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      assert.deepStrictEqual(coverage, {
        'src/file1.js': 'gA==',
        'src/file2.js': 'IA==',
      })
      done()
    })
  })

  it('should skip suites with response metadata coverage when coverage report upload is enabled', (done) => {
    const params = { ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true }
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE_WITH_COVERAGE))

    getSkippableSuites(params, (err, skippableSuites, correlationId, coverage) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js', 'suite2.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      assert.deepStrictEqual(coverage, {
        'src/file1.js': 'gA==',
        'src/file2.js': 'IA==',
      })
      done()
    })
  })

  it('should not skip suites with missing line coverage when coverage report upload is enabled', (done) => {
    const params = { ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true }
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE))

    getSkippableSuites(params, (err, skippableSuites, correlationId) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite2.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      sinon.assert.calledWithExactly(
        log.debug,
        'Received %d skippable %s candidates; excluded %d because line coverage is missing; %d remain.',
        2,
        'suite',
        1,
        1
      )
      sinon.assert.notCalled(log.warn)
      done()
    })
  })

  it('warns if missing line coverage excludes every skippable suite', (done) => {
    const params = { ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true }
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE_WITH_ALL_MISSING_LINE_COVERAGE))

    getSkippableSuites(params, (err, skippableSuites, correlationId) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, [])
      assert.strictEqual(correlationId, 'corr-123')
      sinon.assert.calledWithExactly(
        log.debug,
        'Received %d skippable %s candidates; excluded %d because line coverage is missing; %d remain.',
        2,
        'suite',
        2,
        0
      )
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'All %d skippable %s candidates were excluded: coverage upload is enabled but line coverage is missing.',
        2,
        'suite'
      )
      done()
    })
  })

  it('should keep suites with missing line coverage when coverage report upload is disabled', (done) => {
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE))

    getSkippableSuites(DEFAULT_PARAMS, (err, skippableSuites, correlationId) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js', 'suite2.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      done()
    })
  })

  it('should return suites without coverage when coverage report upload is enabled', (done) => {
    const params = { ...DEFAULT_PARAMS, isCoverageReportUploadEnabled: true }
    nock(BASE_URL)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

    getSkippableSuites(params, (err, skippableSuites, correlationId) => {
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

describe('parseSkippableSuitesResponse', () => {
  it('returns suite-level skippable data with correlation id and coverage', () => {
    const result = parseSkippableSuitesResponse(JSON.stringify(SKIPPABLE_RESPONSE_WITH_COVERAGE), {
      testLevel: 'suite',
    })

    assert.deepStrictEqual(result, {
      skippableSuites: ['suite1.spec.js', 'suite2.spec.js'],
      correlationId: 'corr-123',
      coverage: {
        'src/file1.js': 'gA==',
        'src/file2.js': 'IA==',
      },
      numReceivedSkippableItems: 2,
      numExcludedByMissingLineCoverage: 0,
    })
  })

  it('normalizes legacy Windows separators in coverage paths', () => {
    const result = parseSkippableSuitesResponse(JSON.stringify({
      data: [],
      meta: {
        coverage: {
          'src\\file1.js': 'gA==',
          'src/file2.js': 'IA==',
        },
      },
    }))

    assert.deepStrictEqual(result.coverage, {
      'src/file1.js': 'gA==',
      'src/file2.js': 'IA==',
    })
  })

  it('returns test-level skippable data', () => {
    const result = parseSkippableSuitesResponse(JSON.stringify({
      data: [
        { type: 'suite', attributes: { suite: 'suite1.spec.js' } },
        { type: 'test', attributes: { suite: 'suite1.spec.js', name: 'test 1' } },
      ],
      meta: { correlation_id: 'corr-123' },
    }), { testLevel: 'test' })

    assert.deepStrictEqual(result, {
      skippableSuites: [{ suite: 'suite1.spec.js', name: 'test 1' }],
      correlationId: 'corr-123',
      coverage: {},
      numReceivedSkippableItems: 1,
      numExcludedByMissingLineCoverage: 0,
    })
  })

  it('filters missing line coverage when coverage report upload is enabled', () => {
    const result = parseSkippableSuitesResponse(JSON.stringify(SKIPPABLE_RESPONSE_WITH_MISSING_LINE_COVERAGE), {
      testLevel: 'suite',
      isCoverageReportUploadEnabled: true,
    })

    assert.deepStrictEqual(result.skippableSuites, ['suite2.spec.js'])
    assert.strictEqual(result.numReceivedSkippableItems, 2)
    assert.strictEqual(result.numExcludedByMissingLineCoverage, 1)
  })

  it('validates skippable tests response shape when requested', () => {
    const result = parseSkippableSuitesResponse(JSON.stringify(SKIPPABLE_RESPONSE), {
      validateRequiredFields: true,
    })

    assert.deepStrictEqual(result.skippableSuites, ['suite1.spec.js', 'suite2.spec.js'])
    assert.throws(
      () => parseSkippableSuitesResponse(JSON.stringify({}), { validateRequiredFields: true }),
      /Invalid skippable tests response: data must be an array/
    )
    assert.throws(
      () => parseSkippableSuitesResponse(
        JSON.stringify({ data: [{ type: 'suite', attributes: {} }] }),
        { validateRequiredFields: true }
      ),
      /Invalid skippable tests response: data entry suite must be a string/
    )
  })
})
