'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../setup/core')

const {
  CACHE_MISS,
  TestOptimizationHttpCache,
} = require('../../src/ci-visibility/test-optimization-http-cache')

const SETTINGS_RESPONSE = {
  data: {
    attributes: {
      code_coverage: true,
      tests_skipping: true,
      itr_enabled: true,
      require_git: false,
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

const DISABLED_SETTINGS_RESPONSE = {
  data: {
    attributes: {
      code_coverage: false,
      tests_skipping: false,
      itr_enabled: false,
      require_git: false,
      early_flake_detection: {
        enabled: false,
        slow_test_retries: {},
        faulty_session_threshold: 0,
      },
      flaky_test_retries_enabled: false,
      di_enabled: false,
      known_tests_enabled: false,
      test_management: {
        enabled: false,
      },
      impacted_tests_enabled: false,
      coverage_report_upload_enabled: false,
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

const ENV_NAMES = [
  'TEST_OPTIMIZATION_MANIFEST_FILE',
  'DD_TEST_OPTIMIZATION_MANIFEST_FILE',
  'RUNFILES_DIR',
  'RUNFILES_MANIFEST_FILE',
  'TEST_SRCDIR',
]

function writeCacheLayout (root, options = {}) {
  const { manifest = '1\n' } = options
  const settings = Object.hasOwn(options, 'settings') ? options.settings : SETTINGS_RESPONSE
  const testOptimizationPath = path.join(root, '.testoptimization')
  const httpCachePath = path.join(testOptimizationPath, 'cache', 'http')

  fs.mkdirSync(httpCachePath, { recursive: true })
  fs.writeFileSync(path.join(testOptimizationPath, 'manifest.txt'), manifest)
  if (settings !== undefined) {
    fs.writeFileSync(path.join(httpCachePath, 'settings.json'), JSON.stringify(settings))
  }

  return {
    manifestPath: path.join(testOptimizationPath, 'manifest.txt'),
    httpCachePath,
  }
}

function writeHttpCacheFile (root, fileName, payload) {
  const filePath = path.join(root, '.testoptimization', 'cache', 'http', fileName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return filePath
}

describe('test-optimization-http-cache', () => {
  let previousCwd
  let tmpRoot
  let previousEnv

  beforeEach(() => {
    previousCwd = process.cwd()
    previousEnv = {}
    for (const envName of ENV_NAMES) {
      previousEnv[envName] = process.env[envName]
      delete process.env[envName]
    }

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-http-cache-'))
    process.chdir(tmpRoot)
  })

  afterEach(() => {
    process.chdir(previousCwd)
    for (const envName of ENV_NAMES) {
      if (previousEnv[envName] === undefined) {
        delete process.env[envName]
      } else {
        process.env[envName] = previousEnv[envName]
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('discovers local manifest before env vars', () => {
    writeCacheLayout(tmpRoot, { settings: SETTINGS_RESPONSE })

    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-http-cache-env-'))
    const { manifestPath } = writeCacheLayout(envRoot, { settings: DISABLED_SETTINGS_RESPONSE })
    process.env.TEST_OPTIMIZATION_MANIFEST_FILE = manifestPath

    try {
      const cache = new TestOptimizationHttpCache()
      const settings = cache.readSettings()

      assert.strictEqual(cache.isAvailable(), true)
      assert.strictEqual(settings.isCodeCoverageEnabled, true)
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
    }
  })

  it('uses TEST_OPTIMIZATION_MANIFEST_FILE when no local manifest exists', () => {
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-http-cache-env-'))
    const { manifestPath } = writeCacheLayout(envRoot)
    process.env.TEST_OPTIMIZATION_MANIFEST_FILE = manifestPath

    try {
      const cache = new TestOptimizationHttpCache()

      assert.strictEqual(cache.isAvailable(), true)
      assert.strictEqual(cache.readSettings().isCodeCoverageEnabled, true)
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
    }
  })

  it('uses DD_TEST_OPTIMIZATION_MANIFEST_FILE as an alias', () => {
    const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-http-cache-env-'))
    const { manifestPath } = writeCacheLayout(envRoot)
    process.env.DD_TEST_OPTIMIZATION_MANIFEST_FILE = manifestPath

    try {
      const cache = new TestOptimizationHttpCache()

      assert.strictEqual(cache.isAvailable(), true)
      assert.strictEqual(cache.readSettings().isCodeCoverageEnabled, true)
    } finally {
      fs.rmSync(envRoot, { recursive: true, force: true })
    }
  })

  it('resolves manifests through RUNFILES_DIR', () => {
    const runfilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-runfiles-dir-'))
    const layoutRoot = path.join(runfilesDir, 'workspace')
    writeCacheLayout(layoutRoot)

    process.env.TEST_OPTIMIZATION_MANIFEST_FILE = 'workspace/.testoptimization/manifest.txt'
    process.env.RUNFILES_DIR = runfilesDir

    try {
      const cache = new TestOptimizationHttpCache()
      assert.strictEqual(cache.isAvailable(), true)
    } finally {
      fs.rmSync(runfilesDir, { recursive: true, force: true })
    }
  })

  it('resolves manifests through RUNFILES_MANIFEST_FILE', () => {
    const actualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-runfiles-manifest-'))
    const { manifestPath } = writeCacheLayout(actualRoot)
    const runfilesManifestPath = path.join(tmpRoot, 'MANIFEST')

    process.env.TEST_OPTIMIZATION_MANIFEST_FILE = 'workspace/.testoptimization/manifest.txt'
    process.env.RUNFILES_MANIFEST_FILE = runfilesManifestPath
    fs.writeFileSync(runfilesManifestPath, `workspace/.testoptimization/manifest.txt ${manifestPath}\n`)

    try {
      const cache = new TestOptimizationHttpCache()
      assert.strictEqual(cache.isAvailable(), true)
    } finally {
      fs.rmSync(actualRoot, { recursive: true, force: true })
    }
  })

  it('resolves manifests through TEST_SRCDIR', () => {
    const testSrcdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-test-srcdir-'))
    const layoutRoot = path.join(testSrcdir, 'workspace')
    writeCacheLayout(layoutRoot)

    process.env.TEST_OPTIMIZATION_MANIFEST_FILE = 'workspace/.testoptimization/manifest.txt'
    process.env.TEST_SRCDIR = testSrcdir

    try {
      const cache = new TestOptimizationHttpCache()
      assert.strictEqual(cache.isAvailable(), true)
    } finally {
      fs.rmSync(testSrcdir, { recursive: true, force: true })
    }
  })

  it('accepts supported manifest version formats', () => {
    writeCacheLayout(tmpRoot, { manifest: '\uFEFFversion=1\n' })

    const cache = new TestOptimizationHttpCache()
    assert.strictEqual(cache.isAvailable(), true)
  })

  it('rejects unsupported manifests', () => {
    writeCacheLayout(tmpRoot, { manifest: '2\n' })

    const cache = new TestOptimizationHttpCache()
    assert.strictEqual(cache.isAvailable(), false)
    assert.strictEqual(cache.readSettings(), CACHE_MISS)
  })

  it('treats a supported manifest as unavailable when settings.json is absent', () => {
    writeCacheLayout(tmpRoot, { settings: undefined })

    const cache = new TestOptimizationHttpCache()
    assert.strictEqual(cache.isAvailable(), false)
    assert.strictEqual(cache.readSettings(), CACHE_MISS)
  })

  it('reads endpoint files relative to the manifest directory', () => {
    writeCacheLayout(tmpRoot)
    writeHttpCacheFile(tmpRoot, 'known_tests.json', KNOWN_TESTS_RESPONSE)
    writeHttpCacheFile(tmpRoot, 'skippable_tests.json', SKIPPABLE_RESPONSE)
    writeHttpCacheFile(tmpRoot, 'test_management.json', TEST_MANAGEMENT_RESPONSE)

    const cache = new TestOptimizationHttpCache()
    assert.deepStrictEqual(cache.readKnownTests(), KNOWN_TESTS_RESPONSE.data.attributes.tests)
    assert.deepStrictEqual(cache.readSkippableSuites().skippableSuites, ['suite1.spec.js'])
    assert.deepStrictEqual(cache.readTestManagementTests(), TEST_MANAGEMENT_RESPONSE.data.attributes.modules)
  })

  it('returns cache miss for missing optional endpoint files', () => {
    writeCacheLayout(tmpRoot)

    const cache = new TestOptimizationHttpCache()

    assert.strictEqual(cache.readKnownTests(), CACHE_MISS)
    assert.strictEqual(cache.readSkippableSuites(), CACHE_MISS)
    assert.strictEqual(cache.readTestManagementTests(), CACHE_MISS)
  })

  it('returns cache miss for invalid cache files', () => {
    writeCacheLayout(tmpRoot)

    const cache = new TestOptimizationHttpCache()
    writeHttpCacheFile(tmpRoot, 'settings.json', '{invalid json')
    assert.strictEqual(cache.readSettings(), CACHE_MISS)
    writeHttpCacheFile(tmpRoot, 'known_tests.json', '{invalid json')
    assert.strictEqual(cache.readKnownTests(), CACHE_MISS)
    writeHttpCacheFile(tmpRoot, 'skippable_tests.json', '{invalid json')
    assert.strictEqual(cache.readSkippableSuites(), CACHE_MISS)
    writeHttpCacheFile(tmpRoot, 'test_management.json', '{invalid json')
    assert.strictEqual(cache.readTestManagementTests(), CACHE_MISS)
  })

  it('returns cache miss for settings files missing required attributes', () => {
    for (const settings of [
      {},
      { data: {} },
      { data: { attributes: { code_coverage: true } } },
    ]) {
      fs.rmSync(path.join(tmpRoot, '.testoptimization'), { recursive: true, force: true })
      writeCacheLayout(tmpRoot, { settings })

      const cache = new TestOptimizationHttpCache()
      assert.strictEqual(cache.readSettings(), CACHE_MISS)
      assert.strictEqual(cache.isAvailable(), false)
    }
  })

  it('ignores optional endpoint files after invalid settings disable the cache', () => {
    writeCacheLayout(tmpRoot, { settings: { data: { attributes: { code_coverage: true } } } })
    writeHttpCacheFile(tmpRoot, 'known_tests.json', KNOWN_TESTS_RESPONSE)

    const cache = new TestOptimizationHttpCache()

    assert.strictEqual(cache.readSettings(), CACHE_MISS)
    assert.strictEqual(cache.readKnownTests(), CACHE_MISS)
  })

  it('returns per-file cache miss for optional files missing required attributes', () => {
    writeCacheLayout(tmpRoot)

    const cache = new TestOptimizationHttpCache()
    writeHttpCacheFile(tmpRoot, 'known_tests.json', { data: { attributes: {} } })
    assert.strictEqual(cache.readKnownTests(), CACHE_MISS)
    assert.strictEqual(cache.isAvailable(), true)

    writeHttpCacheFile(tmpRoot, 'skippable_tests.json', { data: [{ type: 'suite', attributes: {} }] })
    assert.strictEqual(cache.readSkippableSuites(), CACHE_MISS)
    assert.strictEqual(cache.isAvailable(), true)

    writeHttpCacheFile(tmpRoot, 'test_management.json', { data: { attributes: {} } })
    assert.strictEqual(cache.readTestManagementTests(), CACHE_MISS)
    assert.strictEqual(cache.isAvailable(), true)

    writeHttpCacheFile(tmpRoot, 'known_tests.json', KNOWN_TESTS_RESPONSE)
    assert.deepStrictEqual(cache.readKnownTests(), KNOWN_TESTS_RESPONSE.data.attributes.tests)
  })
})
