'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const {
  MAX_OUTPUT_MODULES,
  MAX_OUTPUT_SUITES,
  MAX_OUTPUT_TESTS,
  readOfflineOutput,
} = require('../../../../../ci/test-optimization-validation/offline-output')
const id = require('../../../src/id')
const { CiValidationSink, MAX_OUTPUT_BYTES, SUMMARY_PREFIX } =
  require('../../../src/ci-visibility/exporters/ci-validation/sink')
const CiValidationWriter = require('../../../src/ci-visibility/exporters/ci-validation/writer')
const CiValidationExporter = require('../../../src/ci-visibility/exporters/ci-validation')

const VALIDATION_MANIFEST_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_MANIFEST_FILE'
const VALIDATION_OUTPUT_ENV = '_DD_TEST_OPTIMIZATION_VALIDATION_OUTPUT_FILE'

describe('CI validation offline output', () => {
  let outputFile
  let root
  let stderrWrite

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ci-validation-output-'))
    outputFile = path.join(root, 'events.ndjson')
    fs.writeFileSync(outputFile, '', { mode: 0o600 })
    stderrWrite = sinon.stub(process.stderr, 'write').returns(true)
  })

  afterEach(() => {
    stderrWrite.restore()
    fs.rmSync(root, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('writes deterministic CI Visibility events without an HTTP writer', () => {
    const sink = new CiValidationSink(outputFile)
    const writer = new CiValidationWriter({ sink, tags: {} })
    let flushed = false
    writer.append([createTestSpan()])
    writer.flush(() => { flushed = true })
    sink.writeSummary()

    assert.strictEqual(flushed, true)
    const output = readOfflineOutput(outputFile)
    assert.strictEqual(output.events.length, 1)
    assert.strictEqual(output.events[0].type, 'test')
    assert.strictEqual(output.events[0].meta['test.name'], 'offline test')
    assert.match(stderrWrite.firstCall.args[0], new RegExp(`^${SUMMARY_PREFIX}`))
  })

  it('fails closed when the output byte limit is exceeded', () => {
    const sink = new CiValidationSink(outputFile)
    sink.writeTestCycle(Buffer.alloc(MAX_OUTPUT_BYTES), 1)
    sink.writeSummary()

    assert.strictEqual(fs.statSync(outputFile).size, 0)
    assert.strictEqual(process.exitCode, 1)
    const summary = JSON.parse(stderrWrite.firstCall.args[0].slice(SUMMARY_PREFIX.length))
    assert.deepStrictEqual(summary.errors, ['output_byte_limit_exceeded'])
  })

  it('accepts the last allowed and rejects the first excessive module, suite, and test event', () => {
    for (const [type, limit] of [
      ['test_module_end', MAX_OUTPUT_MODULES],
      ['test_suite_end', MAX_OUTPUT_SUITES],
      ['test', MAX_OUTPUT_TESTS],
    ]) {
      const accepted = path.join(root, `${type}-accepted.ndjson`)
      writeEvents(accepted, type, limit)
      assert.strictEqual(readOfflineOutput(accepted).events.length, limit)

      const rejected = path.join(root, `${type}-rejected.ndjson`)
      writeEvents(rejected, type, limit + 1)
      assert.throws(() => readOfflineOutput(rejected), new RegExp(`exceeds ${limit} test`))
    }
  })

  it('rejects symbolic-link output files', function () {
    if (process.platform === 'win32') this.skip()
    const target = path.join(root, 'target.ndjson')
    const link = path.join(root, 'link.ndjson')
    fs.writeFileSync(target, '')
    fs.symlinkSync(target, link)

    assert.throws(() => new CiValidationSink(link), /regular, unlinked file/)
  })
})

describe('CI validation exporter', () => {
  let networkStubs
  let outputFile
  let previousEnvironment
  let root
  let stderrWrite

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-ci-validation-exporter-'))
    outputFile = path.join(root, 'events.ndjson')
    fs.writeFileSync(outputFile, '', { mode: 0o600 })
    const manifestPath = writeValidationCache(root)
    previousEnvironment = {
      DD_API_KEY: process.env.DD_API_KEY,
      [VALIDATION_MANIFEST_ENV]: process.env[VALIDATION_MANIFEST_ENV],
      [VALIDATION_OUTPUT_ENV]: process.env[VALIDATION_OUTPUT_ENV],
    }
    delete process.env.DD_API_KEY
    process.env[VALIDATION_MANIFEST_ENV] = manifestPath
    process.env[VALIDATION_OUTPUT_ENV] = outputFile
    networkStubs = [
      sinon.stub(http, 'request').throws(new Error('unexpected HTTP request')),
      sinon.stub(https, 'request').throws(new Error('unexpected HTTPS request')),
      sinon.stub(net, 'createConnection').throws(new Error('unexpected socket connection')),
      sinon.stub(net, 'createServer').throws(new Error('unexpected socket server')),
    ]
    stderrWrite = sinon.stub(process.stderr, 'write').returns(true)
  })

  afterEach(() => {
    stderrWrite.restore()
    for (const stub of networkStubs) stub.restore()
    restoreEnvironment(previousEnvironment)
    fs.rmSync(root, { recursive: true, force: true })
    process.exitCode = undefined
  })

  it('loads all Test Optimization inputs without an API key or network access', (done) => {
    const exporter = new CiValidationExporter(createExporterConfig())

    exporter.getLibraryConfiguration({}, (settingsError, settings) => {
      assert.ifError(settingsError)
      assert.strictEqual(settings.isKnownTestsEnabled, true)
      exporter.getKnownTests({}, (knownTestsError, knownTests) => {
        assert.ifError(knownTestsError)
        assert.deepStrictEqual(knownTests, { jest: { 'suite.test.js': ['works'] } })
        exporter.getSkippableSuites({ testLevel: 'suite' }, (skippableError, suites) => {
          assert.ifError(skippableError)
          assert.deepStrictEqual(suites, ['suite.test.js'])
          exporter.getTestManagementTests({}, (testManagementError, tests) => {
            assert.ifError(testManagementError)
            assert.strictEqual(tests.jest.suites['suite.test.js'].tests.works.properties.quarantined, true)
            assert(networkStubs.every(stub => stub.notCalled))
            exporter._sink.writeSummary()
            done()
          })
        })
      })
    })
  })

  it('does not call the common request helper when loading cache inputs', () => {
    const exporterPath = require.resolve('../../../src/ci-visibility/exporters/ci-validation')
    const requestPath = require.resolve('../../../src/ci-visibility/requests/request')
    const script = [
      `const requestPath = ${JSON.stringify(requestPath)}`,
      'require.cache[requestPath] = { id: requestPath, filename: requestPath, loaded: true, exports () {',
      "  throw new Error('common request helper was called')",
      '} }',
      "globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }",
      `const Exporter = require(${JSON.stringify(exporterPath)})`,
      `const exporter = new Exporter(${JSON.stringify(createExporterConfig())})`,
      'exporter.getLibraryConfiguration({}, (settingsError) => {',
      '  if (settingsError) throw settingsError',
      '  exporter.getKnownTests({}, knownTestsError => {',
      '    if (knownTestsError) throw knownTestsError',
      '    exporter.getSkippableSuites({ testLevel: "suite" }, skippableError => {',
      '      if (skippableError) throw skippableError',
      '      exporter.getTestManagementTests({}, testManagementError => {',
      '        if (testManagementError) throw testManagementError',
      '        exporter._sink.writeSummary()',
      '      })',
      '    })',
      '  })',
      '})',
    ].join('\n')
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        [VALIDATION_MANIFEST_ENV]: path.join(root, '.testoptimization', 'manifest.txt'),
        [VALIDATION_OUTPUT_ENV]: outputFile,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(child.status, 0, child.stderr)
    assert.doesNotMatch(child.stderr, /common request helper was called/)
  })

  it('does not fall back to repository cache discovery when the private manifest path is missing', () => {
    delete process.env[VALIDATION_MANIFEST_ENV]

    assert.throws(
      () => new CiValidationExporter(createExporterConfig()),
      /requires an explicit private manifest path/
    )
    assert(networkStubs.every(stub => stub.notCalled))
  })

  it('requires an explicit private event output path', () => {
    delete process.env[VALIDATION_OUTPUT_ENV]

    assert.throws(
      () => new CiValidationExporter(createExporterConfig()),
      /requires an explicit private output path/
    )
    assert(networkStubs.every(stub => stub.notCalled))
  })

  it('fails closed when required settings are missing', (done) => {
    fs.rmSync(path.join(root, '.testoptimization', 'cache', 'http', 'settings.json'))
    const exporter = new CiValidationExporter(createExporterConfig())

    exporter.getLibraryConfiguration({}, (error, settings) => {
      assert.match(error.message, /settings fixture is missing/)
      assert.deepStrictEqual(settings, {})
      assert(networkStubs.every(stub => stub.notCalled))
      exporter._sink.writeSummary()
      done()
    })
  })

  it('fails closed when required feature fixtures are missing without falling back to network', (done) => {
    const cacheRoot = path.join(root, '.testoptimization', 'cache', 'http')
    const exporter = new CiValidationExporter(createExporterConfig())

    exporter.getLibraryConfiguration({}, (settingsError) => {
      assert.ifError(settingsError)
      fs.rmSync(path.join(cacheRoot, 'known_tests.json'))
      exporter.getKnownTests({}, knownTestsError => {
        assert.match(knownTestsError.message, /known_tests\.json/)
        fs.rmSync(path.join(cacheRoot, 'skippable_tests.json'))
        exporter.getSkippableSuites({ testLevel: 'suite' }, skippableError => {
          assert.match(skippableError.message, /skippable_tests\.json/)
          fs.rmSync(path.join(cacheRoot, 'test_management.json'))
          exporter.getTestManagementTests({}, testManagementError => {
            assert.match(testManagementError.message, /test_management\.json/)
            assert(networkStubs.every(stub => stub.notCalled))
            exporter._sink.writeSummary()
            done()
          })
        })
      })
    })
  })

  it('fails closed when a feature fixture is malformed without falling back to network', (done) => {
    const knownTestsPath = path.join(root, '.testoptimization', 'cache', 'http', 'known_tests.json')
    fs.writeFileSync(knownTestsPath, '{malformed')
    const exporter = new CiValidationExporter(createExporterConfig())

    exporter.getLibraryConfiguration({}, (settingsError) => {
      assert.ifError(settingsError)
      exporter.getKnownTests({}, knownTestsError => {
        assert.match(knownTestsError.message, /Invalid offline Test Optimization known_tests\.json fixture/)
        assert(networkStubs.every(stub => stub.notCalled))
        exporter._sink.writeSummary()
        done()
      })
    })
  })

  it('disables upload side channels without attempting network access', (done) => {
    const exporter = new CiValidationExporter(createExporterConfig())

    assert.strictEqual(exporter.canUploadTestScreenshots(), false)
    exporter.sendGitMetadata()
    exporter.exportDiLogs()
    exporter.uploadCoverageReport({}, coverageError => {
      assert.match(coverageError.message, /disabled during offline Test Optimization validation/)
      exporter.uploadTestScreenshot({}, screenshotError => {
        assert.match(screenshotError.message, /disabled during offline Test Optimization validation/)
        assert(networkStubs.every(stub => stub.notCalled))
        exporter._sink.writeSummary()
        done()
      })
    })
  })

  it('flushes events and the summary during an explicit process exit', () => {
    const exporterPath = require.resolve('../../../src/ci-visibility/exporters/ci-validation')
    const idPath = require.resolve('../../../src/id')
    const script = [
      "const http = require('node:http')",
      "const https = require('node:https')",
      "const net = require('node:net')",
      "for (const module of [http, https]) module.request = () => { throw new Error('network attempted') }",
      "net.createConnection = () => { throw new Error('network attempted') }",
      "net.createServer = () => { throw new Error('network attempted') }",
      "globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }",
      `const Exporter = require(${JSON.stringify(exporterPath)})`,
      `const id = require(${JSON.stringify(idPath)})`,
      `const config = ${JSON.stringify(createExporterConfig())}`,
      createTestSpan.toString(),
      'const exporter = new Exporter(config)',
      'exporter.export([createTestSpan()])',
      'process.exit(0)',
    ].join(';')
    const child = spawnSync(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        [VALIDATION_MANIFEST_ENV]: path.join(root, '.testoptimization', 'manifest.txt'),
        [VALIDATION_OUTPUT_ENV]: outputFile,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(child.status, 0, child.stderr)
    assert.match(child.stderr, new RegExp(SUMMARY_PREFIX))
    assert.strictEqual(readOfflineOutput(outputFile).events.length, 1)
  })
})

function createTestSpan () {
  return {
    trace_id: id('1234abcd1234abcd'),
    span_id: id('1234abcd1234abcd'),
    parent_id: id('0000000000000000'),
    name: 'test',
    resource: 'offline test',
    service: 'validation',
    type: 'test',
    error: 0,
    meta: {
      'test.name': 'offline test',
      'test.suite': 'offline.spec.js',
      'test.status': 'pass',
    },
    metrics: {},
    start: 123,
    duration: 456,
  }
}

function writeEvents (filename, type, count) {
  fs.writeFileSync(filename, '', { mode: 0o600 })
  const sink = new CiValidationSink(filename)
  const writer = new CiValidationWriter({ sink, tags: {} })
  const spans = []
  for (let index = 0; index < count; index++) {
    spans.push({
      ...createTestSpan(),
      type,
      resource: `${type}-${index}`,
      meta: {
        'test.name': `${type}-${index}`,
        'test.suite': 'offline.spec.js',
        'test.status': 'pass',
      },
    })
  }
  writer.append(spans)
  writer.flush()
  sink.writeSummary()
}

function writeValidationCache (root) {
  const testOptimizationRoot = path.join(root, '.testoptimization')
  const cacheRoot = path.join(testOptimizationRoot, 'cache', 'http')
  fs.mkdirSync(cacheRoot, { recursive: true })
  fs.writeFileSync(path.join(testOptimizationRoot, 'manifest.txt'), '1\n')
  fs.writeFileSync(path.join(cacheRoot, 'settings.json'), JSON.stringify({
    data: {
      attributes: {
        code_coverage: false,
        tests_skipping: true,
        itr_enabled: true,
        require_git: false,
        early_flake_detection: { enabled: true, slow_test_retries: { '5s': 2 }, faulty_session_threshold: 100 },
        flaky_test_retries_enabled: true,
        di_enabled: false,
        known_tests_enabled: true,
        test_management: { enabled: true, attempt_to_fix_retries: 2 },
        impacted_tests_enabled: false,
        coverage_report_upload_enabled: false,
      },
    },
  }))
  fs.writeFileSync(path.join(cacheRoot, 'known_tests.json'), JSON.stringify({
    data: { attributes: { tests: { jest: { 'suite.test.js': ['works'] } } } },
  }))
  fs.writeFileSync(path.join(cacheRoot, 'skippable_tests.json'), JSON.stringify({
    data: [{ type: 'suite', attributes: { suite: 'suite.test.js' } }],
    meta: { correlation_id: 'validation' },
  }))
  fs.writeFileSync(path.join(cacheRoot, 'test_management.json'), JSON.stringify({
    data: {
      attributes: {
        modules: {
          jest: {
            suites: {
              'suite.test.js': { tests: { works: { properties: { quarantined: true } } } },
            },
          },
        },
      },
    },
  }))
  return path.join(testOptimizationRoot, 'manifest.txt')
}

function createExporterConfig () {
  return {
    flushInterval: 0,
    isCiVisibility: true,
    tags: {},
    testOptimization: {
      DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: true,
      DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 2,
      DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: true,
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: false,
      DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: false,
      DD_CIVISIBILITY_ITR_ENABLED: true,
      DD_TEST_FAILED_TEST_REPLAY_ENABLED: false,
      DD_TEST_MANAGEMENT_ENABLED: true,
    },
  }
}

function restoreEnvironment (environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}
