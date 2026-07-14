'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupOfflineFixture,
  createOfflineFixture,
  getOfflineFixturePaths,
  getOfflineScenarioNames,
} = require('../../../../ci/test-optimization-validation/offline-fixtures')
const {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_FILES,
  parseOfflineSummary,
  readOfflineOutput,
} = require('../../../../ci/test-optimization-validation/offline-output')

describe('test optimization offline validation artifacts', () => {
  let repositoryRoot

  beforeEach(() => {
    repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-offline-validation-repository-'))
  })

  afterEach(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true })
  })

  it('creates fixed cache files in a random root outside the repository and removes them', () => {
    const fixture = createOfflineFixture({
      approvedPlanSha256: 'a'.repeat(64),
      offlineFixtureNonce: 'a'.repeat(32),
      framework: { id: 'vitest:app' },
      repositoryRoot,
      scenarioName: 'basic-reporting',
    })
    const otherFixture = createOfflineFixture({
      approvedPlanSha256: 'b'.repeat(64),
      offlineFixtureNonce: 'b'.repeat(32),
      framework: { id: 'vitest:app' },
      repositoryRoot,
      scenarioName: 'basic-reporting',
    })

    assert.strictEqual(path.relative(repositoryRoot, fixture.root).startsWith('..'), true)
    assert.notStrictEqual(fixture.root, otherFixture.root)
    assert.deepStrictEqual(fixture.files.map(({ filename }) => path.relative(fixture.root, filename)), [
      path.join('.testoptimization', 'manifest.txt'),
      path.join('.testoptimization', 'cache', 'http', 'settings.json'),
      path.join('.testoptimization', 'cache', 'http', 'known_tests.json'),
      path.join('.testoptimization', 'cache', 'http', 'skippable_tests.json'),
      path.join('.testoptimization', 'cache', 'http', 'test_management.json'),
    ])

    cleanupOfflineFixture(fixture.root)
    cleanupOfflineFixture(otherFixture.root)
    assert.strictEqual(fs.existsSync(fixture.root), false)
  })

  it('does not enforce POSIX mode bits when ownership APIs are unavailable', () => {
    const offlineFixtureNonce = 'c'.repeat(32)
    const framework = { id: 'vitest:windows' }
    const { base } = getOfflineFixturePaths({
      offlineFixtureNonce,
      framework,
      scenarioName: 'basic-reporting',
    })
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid')
    let fixture

    fs.mkdirSync(base, { mode: 0o755 })
    fs.chmodSync(base, 0o755)
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined })
    try {
      fixture = createOfflineFixture({
        approvedPlanSha256: 'c'.repeat(64),
        offlineFixtureNonce,
        framework,
        repositoryRoot,
        scenarioName: 'basic-reporting',
      })
      assert.strictEqual(fs.existsSync(fixture.manifestPath), true)
    } finally {
      if (fixture) cleanupOfflineFixture(fixture.root)
      fs.rmSync(base, { recursive: true, force: true })
      if (getuidDescriptor) {
        Object.defineProperty(process, 'getuid', getuidDescriptor)
      } else {
        delete process.getuid
      }
    }
  })

  it('selects only the offline fixture executions required by the requested validation scope', () => {
    assert.deepStrictEqual(getOfflineScenarioNames('basic-reporting'), [
      'basic-reporting',
      'basic-reporting-debug',
    ])
    assert.deepStrictEqual(getOfflineScenarioNames('ci-wiring'), [
      'basic-reporting',
      'basic-reporting-debug',
      'ci-wiring',
    ])
    assert.deepStrictEqual(getOfflineScenarioNames('efd'), [
      'basic-reporting',
      'basic-reporting-debug',
      'efd-baseline',
      'efd',
      'efd-debug',
    ])
    assert.deepStrictEqual(getOfflineScenarioNames(), [
      'basic-reporting',
      'basic-reporting-debug',
      'ci-wiring',
      'efd-baseline',
      'efd',
      'efd-debug',
      'atr-baseline',
      'atr',
      'atr-debug',
      'test-management-baseline',
      'test-management',
      'test-management-debug',
    ])
  })

  it('refuses oversized fixture files and removes partial fixtures', () => {
    assert.throws(() => createOfflineFixture({
      approvedPlanSha256: 'b'.repeat(64),
      offlineFixtureNonce: 'b'.repeat(32),
      framework: { id: 'vitest:oversized' },
      repositoryRoot,
      scenarioName: 'efd',
      knownTests: { vitest: { suite: ['x'.repeat(1024 * 1024)] } },
    }), /fixture exceeds .* bytes/)
  })

  it('rejects malformed, deeply nested, and oversized payload files', () => {
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    const outputFile = path.join(testsDirectory, 'tests-1-1-1.json')

    fs.writeFileSync(outputFile, '{not-json}')
    assert.throws(() => readOfflineOutput(outputRoot), /JSON|Unexpected token/)

    fs.writeFileSync(outputFile, '{'.repeat(129))
    assert.throws(() => readOfflineOutput(outputRoot), /JSON nesting exceeds/)

    fs.writeFileSync(outputFile, Buffer.alloc(MAX_OUTPUT_BYTES + 1))
    assert.throws(() => readOfflineOutput(outputRoot), /exceeds .* bytes/)
  })

  it('rejects the first payload file beyond the limit before reading file bodies', () => {
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    const readdirSync = fs.readdirSync
    const filenames = Array.from({ length: MAX_OUTPUT_FILES + 1 }, (_, index) => `tests-${index}-1-1.json`)

    fs.readdirSync = directory => directory === testsDirectory ? filenames : readdirSync(directory)
    try {
      assert.throws(() => readOfflineOutput(outputRoot), /exceeds .* payload files/)
    } finally {
      fs.readdirSync = readdirSync
    }
  })

  it('accepts the last bounded payload string and rejects the first oversized string', () => {
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    const outputFile = path.join(testsDirectory, 'tests-1-1-1.json')
    const payload = value => createTestCyclePayload([{ type: 'test', content: { meta: { value } } }])

    fs.writeFileSync(outputFile, JSON.stringify(payload('x'.repeat(64 * 1024))))
    assert.strictEqual(readOfflineOutput(outputRoot).payloadFileCount, 1)
    fs.writeFileSync(outputFile, JSON.stringify(payload('x'.repeat(64 * 1024 + 1))))
    assert.throws(() => readOfflineOutput(outputRoot), /oversized string/)
  })

  it('rejects unexpected payload entries', () => {
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    fs.writeFileSync(path.join(testsDirectory, 'unexpected.json'), '{}')

    assert.throws(() => readOfflineOutput(outputRoot), /unexpected entry/)
  })

  it('rejects symbolic-link and hard-linked payload files', function () {
    if (process.platform === 'win32') this.skip()
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    const source = path.join(repositoryRoot, 'source.json')
    fs.writeFileSync(source, JSON.stringify(createTestCyclePayload()))
    const outputFile = path.join(testsDirectory, 'tests-1-1-1.json')

    fs.symlinkSync(source, outputFile)
    assert.throws(() => readOfflineOutput(outputRoot), /regular, unlinked file/)

    fs.unlinkSync(outputFile)
    fs.linkSync(source, outputFile)
    assert.throws(() => readOfflineOutput(outputRoot), /regular, unlinked file/)
  })

  it('accepts only bounded versioned stderr summaries', () => {
    const summary = parseOfflineSummary(`runner output\n${createSummary({
      events: 4,
      inputs: { settings: { status: 'loaded' } },
      payloadFiles: 2,
    })}\n`)

    assert.deepStrictEqual(summary, {
      coverageFiles: 0,
      errors: [],
      events: 4,
      input: 'filesystem-cache',
      inputs: { settings: { status: 'loaded' } },
      payloadFiles: 2,
    })
    assert.throws(() => parseOfflineSummary(createSummary({ events: -1 })),
      /Invalid offline Test Optimization exporter summary/)
  })

  it('aggregates every valid process-local exporter summary and cache input status', () => {
    const summary = parseOfflineSummary([
      createSummary({
        events: 4,
        inputs: { settings: { status: 'loaded' } },
        payloadFiles: 2,
      }),
      'runner output',
      createSummary({
        coverageFiles: 1,
        errors: ['output_write_failed'],
        events: 3,
        inputs: { settings: { status: 'error' } },
        payloadFiles: 1,
      }),
    ].join('\n'))

    assert.deepStrictEqual(summary, {
      coverageFiles: 1,
      errors: ['output_write_failed'],
      events: 7,
      input: 'filesystem-cache',
      inputs: { settings: { status: 'error' } },
      payloadFiles: 3,
    })
  })

  it('rejects all exporter summaries when any process summary is malformed', () => {
    assert.throws(() => parseOfflineSummary([
      createSummary({ events: 4, payloadFiles: 2 }),
      createSummary({ events: -1 }),
    ].join('\n')), /Invalid offline Test Optimization exporter summary/)
  })

  it('accepts the last aggregate summary error and rejects the first error beyond the limit', () => {
    const getSummary = errors => createSummary({ errors })
    const firstErrors = Array.from({ length: 10 }, (_, index) => `first_${index}`)
    const secondErrors = Array.from({ length: 10 }, (_, index) => `second_${index}`)

    assert.strictEqual(parseOfflineSummary([
      getSummary(firstErrors),
      getSummary(secondErrors),
    ].join('\n')).errors.length, 20)
    assert.throws(() => parseOfflineSummary([
      getSummary(firstErrors),
      getSummary([...secondErrors, 'too_many']),
    ].join('\n')), /Invalid offline Test Optimization exporter summary/)
  })
})

function createPayloadRoot (repositoryRoot) {
  const outputRoot = path.join(repositoryRoot, 'output')
  const payloadsRoot = path.join(outputRoot, 'payloads')
  const testsDirectory = path.join(payloadsRoot, 'tests')
  fs.mkdirSync(testsDirectory, { recursive: true })
  fs.mkdirSync(path.join(payloadsRoot, 'coverage'))
  return { outputRoot, testsDirectory }
}

function createTestCyclePayload (events = []) {
  return {
    version: 1,
    metadata: { '*': { language: 'javascript' } },
    events,
  }
}

function createSummary (overrides = {}) {
  return `DD_TEST_OPTIMIZATION_VALIDATION_V1 ${JSON.stringify({
    coverageFiles: 0,
    events: 0,
    payloadFiles: 0,
    input: 'filesystem-cache',
    inputs: {},
    errors: [],
    ...overrides,
  })}`
}
