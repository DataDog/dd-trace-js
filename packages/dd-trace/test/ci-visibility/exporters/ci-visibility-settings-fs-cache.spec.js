'use strict'

const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

const { version: tracerVersion } = require('../../../../../package.json')
require('../../../../dd-trace/test/setup/core')
const getConfig = require('../../../src/config')
const { defaults: { hostname, port } } = require('../../../src/config/defaults')
const { parseLibraryConfigurationResponse } =
  require('../../../src/ci-visibility/requests/get-library-configuration')
const { buildCacheKey, getCachePath, getLockPath, withCache } =
  require('../../../src/ci-visibility/requests/fs-cache')
const CiVisibilityExporter =
  require('../../../src/ci-visibility/exporters/ci-visibility-exporter')

const url = new URL(`http://${hostname}:${port}`)

const TEST_CONFIGURATION = {
  repositoryUrl: 'git@github.com:Datadog/dd-trace-js.git',
  sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  branch: 'main',
  testLevel: 'suite',
  osPlatform: 'darwin',
  osVersion: '22.0',
  osArchitecture: 'arm64',
  runtimeName: 'nodejs',
  runtimeVersion: '18.0.0',
}

const SETTINGS_NO_GIT = {
  data: {
    attributes: {
      itr_enabled: true,
      require_git: false,
      code_coverage: true,
      tests_skipping: true,
      known_tests_enabled: false,
    },
  },
}

const SETTINGS_REQUIRE_GIT = {
  data: {
    attributes: {
      itr_enabled: true,
      require_git: true,
      code_coverage: true,
      tests_skipping: true,
      known_tests_enabled: false,
      // Phase 1 disables coverage report upload; phase 2 enables it. nyc reads
      // this field off the settings handoff file, so the final file must hold
      // the phase-2 value, never the transient phase-1 value.
      coverage_report_upload_enabled: false,
    },
  },
}

const SETTINGS_FINAL_AFTER_GIT = {
  data: {
    attributes: {
      itr_enabled: true,
      require_git: false,
      code_coverage: true,
      tests_skipping: true,
      known_tests_enabled: false,
      coverage_report_upload_enabled: true,
    },
  },
}

const SETTINGS_NO_SKIPPING = {
  data: {
    attributes: {
      itr_enabled: true,
      require_git: false,
      code_coverage: false,
      tests_skipping: false,
      known_tests_enabled: false,
    },
  },
}

// Replicates buildSettingsCacheKey from the exporter so tests can locate and
// clean up the deterministic cache file in tmpdir().
function cacheKeyForConfiguration (exporter, testConfiguration) {
  const configuration = exporter.getRequestConfiguration(testConfiguration)
  const config = getConfig()
  const { testOptimization } = config
  const accountNamespace = configuration.isEvpProxy || config.DD_API_KEY === undefined
    ? undefined
    : createHmac('sha256', config.DD_API_KEY)
      .update('dd-trace-js:test-optimization-settings-cache')
      .digest('hex')
  return buildCacheKey('settings', [
    tracerVersion,
    configuration.url?.href,
    configuration.isEvpProxy,
    configuration.evpProxyPrefix,
    accountNamespace,
    configuration.sha,
    configuration.service,
    configuration.env,
    configuration.repositoryUrl,
    configuration.branch,
    configuration.tag,
    configuration.testLevel,
    configuration.osPlatform,
    configuration.osVersion,
    configuration.osArchitecture,
    configuration.runtimeName,
    configuration.runtimeVersion,
    configuration.custom,
    testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE,
    testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING,
    testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED,
  ])
}

function cleanup (exporter, testConfiguration) {
  const key = cacheKeyForConfiguration(exporter, testConfiguration)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

function makeExporter (testOptimization, exporterUrl = url) {
  return new CiVisibilityExporter({
    url: exporterUrl,
    env: 'test',
    service: 'dd-trace-js',
    testOptimization,
  })
}

function requestLibraryConfiguration (exporter) {
  return new Promise((resolve, reject) => {
    exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, libraryConfig) => {
      if (err) return reject(err)
      resolve(libraryConfig)
    })
  })
}

function setApiKey (apiKey) {
  getConfig().DD_API_KEY = apiKey
  process.env.DD_API_KEY = apiKey
}

describe('ci-visibility settings filesystem cache', () => {
  let originalApiKey
  let originalFsCache
  let originalSettingsCachePath
  let originalForceCoverage
  let originalForceTestSkipping
  let originalCoverageReportUpload
  let settingsCacheDir
  let settingsCachePath

  beforeEach(() => {
    originalApiKey = getConfig().DD_API_KEY
    originalFsCache = getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    originalSettingsCachePath = process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    originalForceCoverage = getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE
    originalForceTestSkipping = getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING
    originalCoverageReportUpload =
      getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED
    getConfig().DD_API_KEY = '1'
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = false
    getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED = true

    process.env.DD_API_KEY = '1'

    process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = 'true'
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = true
    settingsCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-settings-handoff-'))
    settingsCachePath = path.join(settingsCacheDir, 'nyc-settings.json')
    process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = settingsCachePath
    nock.cleanAll()
  })

  afterEach(() => {
    getConfig().DD_API_KEY = originalApiKey
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = originalFsCache
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = originalForceCoverage
    getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING = originalForceTestSkipping
    getConfig().testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED =
      originalCoverageReportUpload
    if (originalSettingsCachePath === undefined) {
      delete process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
    } else {
      process.env.DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE = originalSettingsCachePath
    }

    delete process.env.DD_API_KEY

    delete process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    if (settingsCacheDir) {
      fs.rmSync(settingsCacheDir, { recursive: true, force: true })
    }
    nock.cleanAll()
  })

  it('serves a second call from the filesystem cache without hitting the API', (done) => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const firstScope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, firstConfig) => {
      assert.strictEqual(err, null)
      assert.strictEqual(firstScope.isDone(), true)
      assert.strictEqual(firstConfig.requireGit, false)

      const secondScope = nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_GIT))

      exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, secondConfig) => {
        assert.strictEqual(err, null)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT be called on a cache hit')
        assert.strictEqual(secondConfig.requireGit, false)
        cleanup(exporter, TEST_CONFIGURATION)
        done()
      })
    })
  })

  it('writes the final configuration to the cache file on a cache miss', (done) => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err) => {
      assert.strictEqual(err, null)

      const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
      assert.ok(fs.existsSync(getCachePath(key)), 'cache file should exist')
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'lock should be cleaned up')

      const cached = JSON.parse(fs.readFileSync(getCachePath(key), 'utf8'))
      assert.strictEqual(cached.data.requireGit, false)
      cleanup(exporter, TEST_CONFIGURATION)
      done()
    })
  })

  it('isolates filesystem settings by backend account', async () => {
    const firstExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    const secondExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    firstExporter._resolveCanUseCiVisProtocol(true)
    secondExporter._resolveCanUseCiVisProtocol(true)

    try {
      setApiKey('account-one')
      cleanup(firstExporter, TEST_CONFIGURATION)
      nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_GIT))

      const firstConfig = await requestLibraryConfiguration(firstExporter)
      assert.strictEqual(firstConfig.isSuitesSkippingEnabled, true)

      setApiKey('account-two')
      cleanup(secondExporter, TEST_CONFIGURATION)
      const secondScope = nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_SKIPPING))

      const secondConfig = await requestLibraryConfiguration(secondExporter)
      assert.strictEqual(secondScope.isDone(), true, 'the second account should fetch its own settings')
      assert.strictEqual(secondConfig.isSuitesSkippingEnabled, false)
    } finally {
      setApiKey('account-two')
      cleanup(secondExporter, TEST_CONFIGURATION)
      setApiKey('account-one')
      cleanup(firstExporter, TEST_CONFIGURATION)
      setApiKey('1')
    }
  })

  it('isolates filesystem settings by backend origin', async () => {
    const otherUrl = new URL(`http://localhost:${port}`)
    const firstExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    const secondExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true }, otherUrl)
    firstExporter._resolveCanUseCiVisProtocol(true)
    secondExporter._resolveCanUseCiVisProtocol(true)
    cleanup(firstExporter, TEST_CONFIGURATION)
    cleanup(secondExporter, TEST_CONFIGURATION)

    try {
      nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_GIT))
      await requestLibraryConfiguration(firstExporter)

      const secondScope = nock(otherUrl)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_SKIPPING))

      const secondConfig = await requestLibraryConfiguration(secondExporter)
      assert.strictEqual(secondScope.isDone(), true, 'the second backend should fetch its own settings')
      assert.strictEqual(secondConfig.isSuitesSkippingEnabled, false)
    } finally {
      cleanup(firstExporter, TEST_CONFIGURATION)
      cleanup(secondExporter, TEST_CONFIGURATION)
    }
  })

  it('isolates Unix agent endpoints by socket path', () => {
    const firstExporter = makeExporter(
      { DD_CIVISIBILITY_ITR_ENABLED: true },
      new URL('unix:///tmp/dd-agent-one.sock')
    )
    const secondExporter = makeExporter(
      { DD_CIVISIBILITY_ITR_ENABLED: true },
      new URL('unix:///tmp/dd-agent-two.sock')
    )

    const firstConfiguration = firstExporter.getRequestConfiguration(TEST_CONFIGURATION)
    const secondConfiguration = secondExporter.getRequestConfiguration(TEST_CONFIGURATION)
    assert.strictEqual(firstConfiguration.url.origin, 'null')
    assert.strictEqual(secondConfiguration.url.origin, 'null')
    assert.notStrictEqual(
      cacheKeyForConfiguration(firstExporter, TEST_CONFIGURATION),
      cacheKeyForConfiguration(secondExporter, TEST_CONFIGURATION)
    )

    firstExporter._resolveCanUseCiVisProtocol(false)
    secondExporter._resolveCanUseCiVisProtocol(false)
  })

  it('isolates parsed settings by local override flags', async () => {
    const firstExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    const secondExporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    firstExporter._resolveCanUseCiVisProtocol(true)
    secondExporter._resolveCanUseCiVisProtocol(true)

    try {
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = true
      cleanup(firstExporter, TEST_CONFIGURATION)
      nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_SKIPPING))

      const firstConfig = await requestLibraryConfiguration(firstExporter)
      assert.strictEqual(firstConfig.isCodeCoverageEnabled, true)

      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
      cleanup(secondExporter, TEST_CONFIGURATION)
      const secondScope = nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_SKIPPING))

      const secondConfig = await requestLibraryConfiguration(secondExporter)
      assert.strictEqual(secondScope.isDone(), true, 'the second local configuration should fetch its own settings')
      assert.strictEqual(secondConfig.isCodeCoverageEnabled, false)
    } finally {
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
      cleanup(secondExporter, TEST_CONFIGURATION)
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = true
      cleanup(firstExporter, TEST_CONFIGURATION)
      getConfig().testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE = false
    }
  })

  it('only caches the final (post-git-upload) configuration when require_git is true', (done) => {
    const exporter = makeExporter({
      DD_CIVISIBILITY_ITR_ENABLED: true,
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
    })
    // Avoid a real git upload; we resolve the upload promise ourselves below.
    exporter.sendGitMetadata = function () {}
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_REQUIRE_GIT))
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, firstConfig) => {
      assert.strictEqual(err, null)
      assert.strictEqual(scope.isDone(), true, 'both phases should have hit the API')
      assert.strictEqual(firstConfig.requireGit, false, 'final config should have require_git false')

      const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
      const cached = JSON.parse(fs.readFileSync(getCachePath(key), 'utf8'))
      assert.strictEqual(cached.data.requireGit, false, 'cache must hold the final config only')

      // A second call must be served from cache and must not see the phase-1 require_git:true.
      const secondScope = nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_GIT))

      exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, secondConfig) => {
        assert.strictEqual(err, null)
        assert.strictEqual(secondScope.isDone(), false, 'API should NOT be called on a cache hit')
        assert.strictEqual(secondConfig.requireGit, false)
        cleanup(exporter, TEST_CONFIGURATION)
        done()
      })
    })
    // Simulate the git upload finishing so the phase-2 request can proceed.
    setImmediate(() => exporter._resolveGit())
  })

  // Regression: nyc runs in a separate process and reads the library
  // configuration from the file pointed at by DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE
  // (see datadog-plugin-nyc readLibraryConfiguration). The settings request has a
  // two-phase shape (require_git -> upload git metadata -> re-request), and the
  // handoff file must end up holding the final (phase-2) configuration, never the
  // transient phase-1 state, so nyc sees the correct coverage-report-upload flag.
  it('writes only the final config to the nyc settings handoff file across the require_git flow', (done) => {
    const exporter = makeExporter({
      DD_CIVISIBILITY_ITR_ENABLED: true,
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
    })
    // Avoid a real git upload; we resolve the upload promise ourselves below.
    exporter.sendGitMetadata = function () {}
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_REQUIRE_GIT))
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_FINAL_AFTER_GIT))

    exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, finalConfig) => {
      try {
        assert.strictEqual(err, null)
        assert.strictEqual(scope.isDone(), true, 'both phases should have hit the API')
        assert.strictEqual(finalConfig.requireGit, false, 'final config should have require_git false')
        assert.strictEqual(
          finalConfig.isCoverageReportUploadEnabled,
          true,
          'final config should enable coverage report upload'
        )

        assert.ok(fs.existsSync(settingsCachePath), 'nyc settings handoff file should exist')
        const handoff = JSON.parse(fs.readFileSync(settingsCachePath, 'utf8'))
        // The handoff file must reflect the final (phase-2) configuration, not the
        // transient phase-1 state where coverage report upload was disabled.
        assert.strictEqual(handoff.requireGit, false, 'handoff must not retain phase-1 require_git')
        assert.strictEqual(
          handoff.isCoverageReportUploadEnabled,
          true,
          'handoff must hold the phase-2 coverage report upload flag for nyc'
        )
        cleanup(exporter, TEST_CONFIGURATION)
        done()
      } catch (err) {
        cleanup(exporter, TEST_CONFIGURATION)
        done(err)
      }
    })
    // Simulate the git upload finishing so the phase-2 request can proceed.
    setImmediate(() => exporter._resolveGit())
  })

  it('preserves the git upload gate for settings filesystem cache consumers', async () => {
    const exporter = makeExporter({
      DD_CIVISIBILITY_ITR_ENABLED: true,
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: true,
    })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
    const cachedSettings = parseLibraryConfigurationResponse(SETTINGS_NO_GIT)
    fs.writeFileSync(
      getCachePath(key),
      JSON.stringify({ timestamp: Date.now(), data: cachedSettings }),
      'utf8'
    )

    let gitUploadStarted = false
    exporter.sendGitMetadata = function () {
      gitUploadStarted = true
    }

    try {
      const gitUploadResult = exporter._gitUploadPromise.then(error => ({ settled: true, error }))
      const libraryConfig = await requestLibraryConfiguration(exporter)
      const pendingResult = await Promise.race([
        gitUploadResult,
        Promise.resolve({ settled: false }),
      ])

      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(gitUploadStarted, true, 'a cache consumer must start its own git upload')
      assert.strictEqual(pendingResult.settled, false, 'the cache hit must not release the git gate')

      exporter._resolveGit()
      const { error } = await gitUploadResult
      assert.strictEqual(error, undefined)
    } finally {
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('does not consume the git upload timeout while waiting for the settings cache', async () => {
    const clock = sinon.useFakeTimers()
    const exporter = makeExporter({
      DD_CIVISIBILITY_ITR_ENABLED: true,
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: false,
    })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
    fs.writeFileSync(getLockPath(key), String(Date.now()), 'utf8')

    try {
      const settingsRequest = requestLibraryConfiguration(exporter)
      await clock.tickAsync(60_000)

      const cachedSettings = parseLibraryConfigurationResponse(SETTINGS_NO_GIT)
      fs.writeFileSync(
        getCachePath(key),
        JSON.stringify({ timestamp: Date.now(), data: cachedSettings }),
        'utf8'
      )
      await clock.tickAsync(500)

      const libraryConfig = await settingsRequest
      const gitUploadError = await exporter._gitUploadPromise
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(gitUploadError, undefined)
    } finally {
      clock.restore()
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  const validCachedSettings = parseLibraryConfigurationResponse(SETTINGS_NO_GIT)
  for (const [description, data] of [
    ['null', null],
    ['an array', []],
    ['an incomplete object', {}],
    ['failed test replay without flaky test retries', {
      ...validCachedSettings,
      isDiEnabled: true,
      isFlakyTestRetriesEnabled: false,
    }],
    ['early flake detection without known tests', {
      ...validCachedSettings,
      isEarlyFlakeDetectionEnabled: true,
      isKnownTestsEnabled: false,
    }],
    ['an incomplete EFD retry policy', {
      ...validCachedSettings,
      isEarlyFlakeDetectionEnabled: true,
      earlyFlakeDetectionRetryPolicy: { schedulingRetryCount: 1 },
    }],
    ['a null EFD retry policy', {
      ...validCachedSettings,
      earlyFlakeDetectionRetryPolicy: null,
    }],
    ['an invalid EFD scheduling retry count', {
      ...validCachedSettings,
      earlyFlakeDetectionRetryPolicy: {
        ...validCachedSettings.earlyFlakeDetectionRetryPolicy,
        schedulingRetryCount: -1,
      },
    }],
    ['an inconsistent EFD scheduling retry count', {
      ...validCachedSettings,
      earlyFlakeDetectionRetryPolicy: {
        ...validCachedSettings.earlyFlakeDetectionRetryPolicy,
        schedulingRetryCount: 1,
      },
    }],
    ['an invalid EFD duration retry entry', {
      ...validCachedSettings,
      earlyFlakeDetectionRetryPolicy: {
        ...validCachedSettings.earlyFlakeDetectionRetryPolicy,
        durationRetryCounts: [
          null,
          ...validCachedSettings.earlyFlakeDetectionRetryPolicy.durationRetryCounts.slice(1),
        ],
      },
    }],
    ['an excessive EFD duration retry count', {
      ...validCachedSettings,
      earlyFlakeDetectionRetryPolicy: {
        schedulingRetryCount: 101,
        durationRetryCounts: [
          {
            ...validCachedSettings.earlyFlakeDetectionRetryPolicy.durationRetryCounts[0],
            retryCount: 101,
          },
          ...validCachedSettings.earlyFlakeDetectionRetryPolicy.durationRetryCounts.slice(1),
        ],
      },
    }],
    ['an invalid EFD faulty threshold', {
      ...validCachedSettings,
      earlyFlakeDetectionFaultyThreshold: 101,
    }],
    ['an excessive test management retry count', {
      ...validCachedSettings,
      testManagementAttemptToFixRetries: 101,
    }],
  ]) {
    it(`treats malformed cache data (${description}) as a miss and falls back to the API`, (done) => {
      const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
      exporter._resolveCanUseCiVisProtocol(true)
      cleanup(exporter, TEST_CONFIGURATION)

      const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
      fs.writeFileSync(
        getCachePath(key),
        JSON.stringify({ timestamp: Date.now(), data }),
        'utf8'
      )

      const scope = nock(url)
        .post('/api/v2/libraries/tests/services/setting')
        .reply(200, JSON.stringify(SETTINGS_NO_GIT))

      exporter.getLibraryConfiguration(TEST_CONFIGURATION, (err, libraryConfig) => {
        try {
          assert.strictEqual(err, null, 'malformed cache must not surface an error')
          assert.ok(libraryConfig, 'malformed cache must fall back to a real config')
          assert.strictEqual(libraryConfig.requireGit, false)
          assert.strictEqual(scope.isDone(), true, 'malformed cache should fall back to the API')
          cleanup(exporter, TEST_CONFIGURATION)
          done()
        } catch (err) {
          cleanup(exporter, TEST_CONFIGURATION)
          done(err)
        }
      })
    })
  }

  it('bypasses an invalid cache entry that cannot be deleted', async () => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
    const cachePath = getCachePath(key)
    fs.writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), data: null }), 'utf8')

    const unlinkSync = fs.unlinkSync
    const unlinkStub = sinon.stub(fs, 'unlinkSync').callsFake(path => {
      if (path === cachePath) {
        const err = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      }
      return unlinkSync(path)
    })
    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    try {
      const libraryConfig = await requestLibraryConfiguration(exporter)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(scope.isDone(), true, 'an undeletable invalid entry should be bypassed')
    } finally {
      unlinkStub.restore()
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('bypasses the filesystem cache when its lock cannot be created', async () => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const lockPath = getLockPath(cacheKeyForConfiguration(exporter, TEST_CONFIGURATION))
    const openSync = fs.openSync
    const openStub = sinon.stub(fs, 'openSync').callsFake((filePath, ...args) => {
      if (filePath === lockPath) {
        const err = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      }
      return openSync(filePath, ...args)
    })
    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    try {
      const libraryConfig = await requestLibraryConfiguration(exporter)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(scope.isDone(), true, 'an unavailable lock should bypass the cache')
    } finally {
      openStub.restore()
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('bypasses the filesystem cache when a stale lock cannot be deleted', async () => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const lockPath = getLockPath(cacheKeyForConfiguration(exporter, TEST_CONFIGURATION))
    fs.writeFileSync(lockPath, '0', 'utf8')
    const unlinkSync = fs.unlinkSync
    const unlinkStub = sinon.stub(fs, 'unlinkSync').callsFake(filePath => {
      if (filePath === lockPath) {
        const err = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      }
      return unlinkSync(filePath)
    })
    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    try {
      const libraryConfig = await requestLibraryConfiguration(exporter)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(scope.isDone(), true, 'an undeletable stale lock should bypass the cache')
    } finally {
      unlinkStub.restore()
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('takes over a stale filesystem cache lock', async () => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const key = cacheKeyForConfiguration(exporter, TEST_CONFIGURATION)
    fs.writeFileSync(getLockPath(key), '0', 'utf8')
    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    try {
      const libraryConfig = await requestLibraryConfiguration(exporter)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(scope.isDone(), true, 'the stale lock owner should fetch settings')
      assert.strictEqual(fs.existsSync(getCachePath(key)), true, 'the stale lock owner should populate the cache')
      assert.strictEqual(fs.existsSync(getLockPath(key)), false, 'the replacement lock should be released')
    } finally {
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('bypasses the cache when a stale lock cannot be replaced', async () => {
    const exporter = makeExporter({ DD_CIVISIBILITY_ITR_ENABLED: true })
    exporter._resolveCanUseCiVisProtocol(true)
    cleanup(exporter, TEST_CONFIGURATION)

    const lockPath = getLockPath(cacheKeyForConfiguration(exporter, TEST_CONFIGURATION))
    fs.writeFileSync(lockPath, '0', 'utf8')
    const openSync = fs.openSync
    let lockOpenCount = 0
    const openStub = sinon.stub(fs, 'openSync').callsFake((filePath, ...args) => {
      if (filePath === lockPath && ++lockOpenCount === 2) {
        const err = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      }
      return openSync(filePath, ...args)
    })
    const scope = nock(url)
      .post('/api/v2/libraries/tests/services/setting')
      .reply(200, JSON.stringify(SETTINGS_NO_GIT))

    try {
      const libraryConfig = await requestLibraryConfiguration(exporter)
      assert.strictEqual(libraryConfig.requireGit, false)
      assert.strictEqual(scope.isDone(), true, 'a failed stale-lock takeover should bypass the cache')
    } finally {
      openStub.restore()
      cleanup(exporter, TEST_CONFIGURATION)
    }
  })

  it('retries when another process replaces a stale lock first', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000_000 })
    const key = buildCacheKey('settings-lock-race', [process.pid])
    const lockPath = getLockPath(key)
    try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath) } catch { /* ignore */ }
    fs.writeFileSync(lockPath, '0', 'utf8')
    const openSync = fs.openSync
    let lockOpenCount = 0
    const openStub = sinon.stub(fs, 'openSync').callsFake((filePath, ...args) => {
      if (filePath === lockPath && ++lockOpenCount === 2) {
        const fd = openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
        fs.writeSync(fd, '0')
        fs.closeSync(fd)
        const err = new Error('lock replaced by another process')
        err.code = 'EEXIST'
        throw err
      }
      return openSync(filePath, ...args)
    })

    try {
      const cacheResult = new Promise((resolve, reject) => {
        withCache(key, (activeCacheKey, done) => {
          assert.strictEqual(activeCacheKey, key)
          done(null, 'fetched')
        }, (err, result) => {
          if (err) return reject(err)
          resolve(result)
        })
      })
      await clock.tickAsync(500)
      assert.strictEqual(await cacheResult, 'fetched')
    } finally {
      openStub.restore()
      clock.restore()
      try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath) } catch { /* ignore */ }
    }
  })
})
