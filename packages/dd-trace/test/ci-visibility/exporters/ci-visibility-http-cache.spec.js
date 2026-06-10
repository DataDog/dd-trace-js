'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

require('../../setup/core')

const getConfig = require('../../../src/config')
const CiVisibilityExporter = require('../../../src/ci-visibility/exporters/ci-visibility-exporter')
const { defaults: { hostname, port } } = require('../../../src/config/defaults')

const SETTINGS_RESPONSE = {
  data: {
    attributes: {
      code_coverage: true,
      tests_skipping: true,
      itr_enabled: true,
      require_git: true,
      early_flake_detection: {
        enabled: true,
        slow_test_retries: {
          '5s': 4,
        },
        faulty_session_threshold: 12,
      },
      flaky_test_retries_enabled: true,
      di_enabled: true,
      known_tests_enabled: true,
      test_management: {
        enabled: true,
        attempt_to_fix_retries: 8,
      },
      impacted_tests_enabled: true,
      coverage_report_upload_enabled: true,
    },
  },
}

const KNOWN_TESTS_RESPONSE = {
  data: {
    attributes: {
      tests: {
        jest: {
          'suite1.spec.js': ['test1'],
        },
      },
    },
  },
}

const SKIPPABLE_RESPONSE = {
  meta: {
    correlation_id: 'corr-123',
    coverage: {
      'src/file.js': 'gA==',
    },
  },
  data: [
    { type: 'suite', attributes: { suite: 'suite1.spec.js' } },
  ],
}

const TEST_MANAGEMENT_RESPONSE = {
  data: {
    attributes: {
      modules: {
        jest: {
          suites: {
            'suite1.spec.js': {
              tests: {
                test1: { properties: { disabled: true } },
              },
            },
          },
        },
      },
    },
  },
}

function writeCacheLayout (root, options = {}) {
  const {
    settings = SETTINGS_RESPONSE,
    knownTests = KNOWN_TESTS_RESPONSE,
    skippableTests = SKIPPABLE_RESPONSE,
    testManagement = TEST_MANAGEMENT_RESPONSE,
  } = options
  const httpCachePath = path.join(root, '.testoptimization', 'cache', 'http')
  fs.mkdirSync(httpCachePath, { recursive: true })
  fs.writeFileSync(path.join(root, '.testoptimization', 'manifest.txt'), '1\n')
  if (settings !== undefined) {
    fs.writeFileSync(path.join(httpCachePath, 'settings.json'), JSON.stringify(settings))
  }
  if (knownTests !== undefined) {
    fs.writeFileSync(path.join(httpCachePath, 'known_tests.json'), JSON.stringify(knownTests))
  }
  if (skippableTests !== undefined) {
    fs.writeFileSync(path.join(httpCachePath, 'skippable_tests.json'), JSON.stringify(skippableTests))
  }
  if (testManagement !== undefined) {
    fs.writeFileSync(path.join(httpCachePath, 'test_management.json'), JSON.stringify(testManagement))
  }
}

describe('CI Visibility Exporter Test Optimization HTTP cache', () => {
  const url = new URL(`http://${hostname}:${port}`)

  let previousCwd
  let previousSettingsCachePath
  let tmpRoot

  beforeEach(() => {
    previousCwd = process.cwd()
    previousSettingsCachePath = process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-exporter-http-cache-'))
    writeCacheLayout(tmpRoot)
    process.chdir(tmpRoot)
    delete process.env.DD_API_KEY
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    getConfig().apiKey = undefined
    nock.cleanAll()
  })

  afterEach(() => {
    process.chdir(previousCwd)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    process.env.DD_API_KEY = '1'
    if (previousSettingsCachePath === undefined) {
      delete process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    } else {
      process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = previousSettingsCachePath
    }
    getConfig().apiKey = '1'
    nock.cleanAll()
  })

  it('uses cached settings without an API key or settings HTTP request', (done) => {
    const settingsScope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, {})

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isEarlyFlakeDetectionEnabled: true,
      isFlakyTestRetriesEnabled: true,
      isImpactedTestsEnabled: true,
      isIntelligentTestRunnerEnabled: true,
      isTestDynamicInstrumentationEnabled: true,
      isTestManagementEnabled: true,
    })

    ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
      assert.strictEqual(err, null)
      assert.strictEqual(libraryConfig.requireGit, true)
      assert.strictEqual(libraryConfig.isCodeCoverageEnabled, true)
      assert.strictEqual(libraryConfig.isSuitesSkippingEnabled, true)
      assert.strictEqual(libraryConfig.isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(libraryConfig.isTestManagementEnabled, true)
      assert.strictEqual(libraryConfig.isImpactedTestsEnabled, true)
      assert.strictEqual(libraryConfig.isCoverageReportUploadEnabled, true)
      assert.strictEqual(settingsScope.isDone(), false)
      done()
    })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
  })

  it('writes cached settings to the nyc settings handoff cache', (done) => {
    const settingsCachePath = path.join(tmpRoot, 'nyc-settings.json')
    process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = settingsCachePath

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isEarlyFlakeDetectionEnabled: true,
      isFlakyTestRetriesEnabled: true,
      isImpactedTestsEnabled: true,
      isIntelligentTestRunnerEnabled: true,
      isTestDynamicInstrumentationEnabled: true,
      isTestManagementEnabled: true,
    })

    ciVisibilityExporter.getLibraryConfiguration({}, (err, libraryConfig) => {
      try {
        assert.strictEqual(err, null)
        assert.strictEqual(libraryConfig.isCoverageReportUploadEnabled, true)

        const cachedSettings = JSON.parse(fs.readFileSync(settingsCachePath, 'utf8'))
        assert.strictEqual(cachedSettings.isCoverageReportUploadEnabled, true)
        assert.strictEqual(cachedSettings.isCodeCoverageEnabled, true)
        assert.strictEqual(cachedSettings.requireGit, true)
        done()
      } catch (err) {
        done(err)
      }
    })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
  })

  it('falls back to live settings when cached settings are missing', (done) => {
    fs.rmSync(path.join(tmpRoot, '.testoptimization', 'cache', 'http', 'settings.json'))
    const liveSettingsResponse = JSON.parse(JSON.stringify(SETTINGS_RESPONSE))
    liveSettingsResponse.data.attributes.require_git = false
    getConfig().apiKey = '1'

    const settingsScope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(liveSettingsResponse))

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isEarlyFlakeDetectionEnabled: true,
      isFlakyTestRetriesEnabled: true,
      isImpactedTestsEnabled: true,
      isIntelligentTestRunnerEnabled: true,
      isTestDynamicInstrumentationEnabled: true,
      isTestManagementEnabled: true,
    })

    ciVisibilityExporter.getLibraryConfiguration({
      repositoryUrl: 'https://github.com/example/repo',
    }, (err, libraryConfig) => {
      assert.strictEqual(err, null)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(libraryConfig.isCodeCoverageEnabled, true)
      assert.strictEqual(libraryConfig.isSuitesSkippingEnabled, true)
      assert.strictEqual(libraryConfig.isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(libraryConfig.isKnownTestsEnabled, true)
      assert.strictEqual(libraryConfig.isTestManagementEnabled, true)
      assert.strictEqual(libraryConfig.isImpactedTestsEnabled, true)
      assert.strictEqual(libraryConfig.isCoverageReportUploadEnabled, true)
      assert.strictEqual(settingsScope.isDone(), true)
      done()
    })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
  })

  it('skips git metadata upload when the HTTP cache is available', (done) => {
    const gitScope = nock(url)
      .post('/api/v2/git/repository/search_commits')
      .reply(200, { data: [] })

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isGitUploadEnabled: true,
    })

    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter.sendGitMetadata('https://github.com/example/repo')

    ciVisibilityExporter._gitUploadPromise.then((err) => {
      assert.strictEqual(err, undefined)
      assert.strictEqual(gitScope.isDone(), false)
      done()
    })
  })

  it('uses cached known tests without an API key or known-tests HTTP request', (done) => {
    const knownTestsScope = nock(url)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, {})

    const ciVisibilityExporter = new CiVisibilityExporter({ url })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }

    ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      assert.strictEqual(knownTestsScope.isDone(), false)
      done()
    })
  })

  it('falls back to live known tests when cached known tests are missing', (done) => {
    fs.rmSync(path.join(tmpRoot, '.testoptimization', 'cache', 'http', 'known_tests.json'))
    getConfig().apiKey = '1'
    const knownTestsScope = nock(url)
      .post('/api/v2/ci/libraries/tests')
      .reply(200, JSON.stringify(KNOWN_TESTS_RESPONSE))

    const ciVisibilityExporter = new CiVisibilityExporter({ url })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isKnownTestsEnabled: true }

    ciVisibilityExporter.getKnownTests({}, (err, knownTests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(knownTests, KNOWN_TESTS_RESPONSE.data.attributes.tests)
      assert.strictEqual(knownTestsScope.isDone(), true)
      done()
    })
  })

  it('uses cached skippable tests without waiting on git upload', (done) => {
    const skippableScope = nock(url)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, {})

    const ciVisibilityExporter = new CiVisibilityExporter({ url, isIntelligentTestRunnerEnabled: true })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }

    ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites, correlationId, coverage) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      assert.deepStrictEqual(coverage, { 'src/file.js': 'gA==' })
      assert.strictEqual(skippableScope.isDone(), false)
      done()
    })
  })

  it('falls back to live skippable tests when cached skippable tests are missing', (done) => {
    fs.rmSync(path.join(tmpRoot, '.testoptimization', 'cache', 'http', 'skippable_tests.json'))
    getConfig().apiKey = '1'
    const skippableScope = nock(url)
      .post('/api/v2/ci/tests/skippable')
      .reply(200, JSON.stringify(SKIPPABLE_RESPONSE))

    const ciVisibilityExporter = new CiVisibilityExporter({ url, isIntelligentTestRunnerEnabled: true })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isSuitesSkippingEnabled: true }

    ciVisibilityExporter.getSkippableSuites({}, (err, skippableSuites, correlationId, coverage) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(skippableSuites, ['suite1.spec.js'])
      assert.strictEqual(correlationId, 'corr-123')
      assert.deepStrictEqual(coverage, { 'src/file.js': 'gA==' })
      assert.strictEqual(skippableScope.isDone(), true)
      done()
    })
  })

  it('uses cached test management tests without an API key or test-management HTTP request', (done) => {
    const testManagementScope = nock(url)
      .post('/api/v2/test/libraries/test-management/tests')
      .reply(200, {})

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isTestManagementEnabled: true,
    })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isTestManagementEnabled: true }

    ciVisibilityExporter.getTestManagementTests({}, (err, tests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(tests, TEST_MANAGEMENT_RESPONSE.data.attributes.modules)
      assert.strictEqual(testManagementScope.isDone(), false)
      done()
    })
  })

  it('falls back to live test management tests when cached test management tests are missing', (done) => {
    fs.rmSync(path.join(tmpRoot, '.testoptimization', 'cache', 'http', 'test_management.json'))
    getConfig().apiKey = '1'
    const testManagementScope = nock(url)
      .post('/api/v2/test/libraries/test-management/tests')
      .reply(200, JSON.stringify(TEST_MANAGEMENT_RESPONSE))

    const ciVisibilityExporter = new CiVisibilityExporter({
      url,
      isTestManagementEnabled: true,
    })
    ciVisibilityExporter._resolveCanUseCiVisProtocol(true)
    ciVisibilityExporter._libraryConfig = { isTestManagementEnabled: true }

    ciVisibilityExporter.getTestManagementTests({}, (err, tests) => {
      assert.strictEqual(err, null)
      assert.deepStrictEqual(tests, TEST_MANAGEMENT_RESPONSE.data.attributes.modules)
      assert.strictEqual(testManagementScope.isDone(), true)
      done()
    })
  })
})
