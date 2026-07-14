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
  MAX_OUTPUT_RECORDS,
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

  it('rejects malformed, deeply nested, and oversized event artifacts', () => {
    const outputFile = path.join(repositoryRoot, 'events.ndjson')

    fs.writeFileSync(outputFile, '{not-json}\n')
    assert.throws(() => readOfflineOutput(outputFile), /JSON|Unexpected token/)

    fs.writeFileSync(outputFile, `${'{'.repeat(129)}\n`)
    assert.throws(() => readOfflineOutput(outputFile), /JSON nesting exceeds/)

    fs.writeFileSync(outputFile, Buffer.alloc(MAX_OUTPUT_BYTES + 1))
    assert.throws(() => readOfflineOutput(outputFile), /exceeds .* bytes/)
  })

  it('rejects the first event record beyond the limit', () => {
    const outputFile = path.join(repositoryRoot, 'events.ndjson')
    const record = `${JSON.stringify({
      version: 1,
      kind: 'input',
      payload: { name: 'settings', status: 'loaded' },
    })}\n`

    fs.writeFileSync(outputFile, record.repeat(MAX_OUTPUT_RECORDS))
    assert.strictEqual(readOfflineOutput(outputFile).recordCount, MAX_OUTPUT_RECORDS)
    fs.appendFileSync(outputFile, record)
    assert.throws(() => readOfflineOutput(outputFile), /exceeds .* records/)
  })

  it('accepts the last bounded artifact string and rejects the first oversized string', () => {
    const outputFile = path.join(repositoryRoot, 'events.ndjson')
    const record = error => `${JSON.stringify({
      version: 1,
      kind: 'input',
      payload: { name: 'settings', status: 'error', error },
    })}\n`

    fs.writeFileSync(outputFile, record('x'.repeat(64 * 1024)))
    assert.strictEqual(readOfflineOutput(outputFile).recordCount, 1)
    fs.writeFileSync(outputFile, record('x'.repeat(64 * 1024 + 1)))
    assert.throws(() => readOfflineOutput(outputFile), /oversized string/)
  })

  it('accepts only bounded versioned stderr summaries', () => {
    const summary = parseOfflineSummary(
      'runner output\nDD_TEST_OPTIMIZATION_VALIDATION_V1 ' +
      '{"events":4,"records":2,"input":"filesystem-cache","errors":[]}\n'
    )

    assert.deepStrictEqual(summary, {
      errors: [],
      events: 4,
      input: 'filesystem-cache',
      records: 2,
    })
    assert.strictEqual(parseOfflineSummary(
      'DD_TEST_OPTIMIZATION_VALIDATION_V1 {"events":-1,"records":2,"input":"filesystem-cache","errors":[]}'
    ), undefined)
  })
})
