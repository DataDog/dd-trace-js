'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')

require('../../../../dd-trace/test/setup/core')
const getConfig = require('../../../src/config')
const { defaults: { hostname, port } } = require('../../../src/config/defaults')
const { buildCacheKey, getCachePath, getLockPath } =
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
    },
  },
}

// Replicates buildSettingsCacheKey from the exporter so tests can locate and
// clean up the deterministic cache file in tmpdir().
function cacheKeyForConfiguration (exporter, testConfiguration) {
  const configuration = exporter.getRequestConfiguration(testConfiguration)
  return buildCacheKey('settings', [
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
  ])
}

function cleanup (exporter, testConfiguration) {
  const key = cacheKeyForConfiguration(exporter, testConfiguration)
  try { fs.unlinkSync(getCachePath(key)) } catch { /* ignore */ }
  try { fs.unlinkSync(getLockPath(key)) } catch { /* ignore */ }
}

function makeExporter (testOptimization) {
  return new CiVisibilityExporter({
    url,
    env: 'test',
    service: 'dd-trace-js',
    testOptimization,
  })
}

describe('ci-visibility settings filesystem cache', () => {
  let originalApiKey
  let originalFsCache

  beforeEach(() => {
    originalApiKey = getConfig().DD_API_KEY
    originalFsCache = getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
    getConfig().DD_API_KEY = '1'

    process.env.DD_API_KEY = '1'

    process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = 'true'
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = true
    nock.cleanAll()
  })

  afterEach(() => {
    getConfig().DD_API_KEY = originalApiKey
    getConfig().DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE = originalFsCache

    delete process.env.DD_API_KEY

    delete process.env.DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE
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
})
