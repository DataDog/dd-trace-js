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
const { getArtifactId } = require('../../../../ci/test-optimization-validation/artifact-id')
const {
  MAX_COMPLETION_FILES,
  MAX_DECODED_COLLECTION_ENTRIES,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_FILES,
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

  it('distinguishes an exporter that never initialized from one that did not complete', () => {
    const outputRoot = path.join(repositoryRoot, 'not-initialized')
    fs.mkdirSync(outputRoot)

    assert.strictEqual(readOfflineOutput(outputRoot).initialized, false)

    fs.mkdirSync(path.join(outputRoot, 'payloads'))
    assert.throws(() => readOfflineOutput(outputRoot), /did not write completion evidence/)
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

  it('maps colliding sanitized framework ids to distinct stable fixture and artifact paths', () => {
    const firstFramework = { id: 'jest:a/b' }
    const secondFramework = { id: 'jest:a?b' }
    const input = {
      offlineFixtureNonce: 'd'.repeat(32),
      scenarioName: 'basic-reporting',
    }
    const firstId = getArtifactId(firstFramework.id)
    const secondId = getArtifactId(secondFramework.id)

    assert.notStrictEqual(firstId, secondId)
    assert.strictEqual(firstId, getArtifactId(firstFramework.id))
    assert(firstId.length <= 85)
    assert.notStrictEqual(
      getOfflineFixturePaths({ ...input, framework: firstFramework }).root,
      getOfflineFixturePaths({ ...input, framework: secondFramework }).root
    )
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
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    const outputFile = path.join(testsDirectory, `tests-${processId}-1-1-1.json`)

    fs.writeFileSync(outputFile, '{not-json}')
    assert.throws(() => readOfflineOutput(outputRoot), /JSON|Unexpected token/)

    fs.writeFileSync(outputFile, '{'.repeat(129))
    assert.throws(() => readOfflineOutput(outputRoot), /payload nesting exceeds/)

    fs.writeFileSync(outputFile, Buffer.alloc(MAX_OUTPUT_BYTES + 1))
    assert.throws(() => readOfflineOutput(outputRoot), /exceeds .* bytes/)
  })

  it('rejects the first payload file beyond the limit before reading file bodies', () => {
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    const readdirSync = fs.readdirSync
    const filenames = Array.from(
      { length: MAX_OUTPUT_FILES + 1 },
      (_, index) => `tests-${processId}-${index}-1-1.json`
    )

    fs.readdirSync = directory => directory === testsDirectory ? filenames : readdirSync(directory)
    try {
      assert.throws(() => readOfflineOutput(outputRoot), /exceeds .* payload files/)
    } finally {
      fs.readdirSync = readdirSync
    }
  })

  it('accepts the last bounded payload string and rejects the first oversized string', () => {
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    const outputFile = path.join(testsDirectory, `tests-${processId}-1-1-1.json`)
    const payload = value => createTestCyclePayload([createProjectedEvent({ 'test.name': value })])

    fs.writeFileSync(outputFile, JSON.stringify(payload('x'.repeat(64 * 1024 - 1))))
    writeCompletion(outputRoot, processId, { eventsObserved: 1, eventsRetained: 1, payloadFiles: 1 })
    assert.strictEqual(readOfflineOutput(outputRoot).payloadFileCount, 1)
    fs.writeFileSync(outputFile, JSON.stringify(payload('x'.repeat(64 * 1024 + 1))))
    assert.throws(() => readOfflineOutput(outputRoot), /string larger/)
  })

  it('rejects unexpected payload entries', () => {
    const { outputRoot, testsDirectory } = createPayloadRoot(repositoryRoot)
    fs.writeFileSync(path.join(testsDirectory, 'unexpected.json'), '{}')

    assert.throws(() => readOfflineOutput(outputRoot), /unexpected entry/)
  })

  it('rejects symbolic-link and hard-linked payload files', function () {
    if (process.platform === 'win32') this.skip()
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    const source = path.join(repositoryRoot, 'source.json')
    fs.writeFileSync(source, JSON.stringify(createTestCyclePayload()))
    const outputFile = path.join(testsDirectory, `tests-${processId}-1-1-1.json`)

    fs.symlinkSync(source, outputFile)
    assert.throws(() => readOfflineOutput(outputRoot), /regular, unlinked file/)

    fs.unlinkSync(outputFile)
    fs.linkSync(source, outputFile)
    assert.throws(() => readOfflineOutput(outputRoot), /regular, unlinked file/)
  })

  it('requires and aggregates per-process completion records independently of stderr', () => {
    const first = createPayloadRoot(repositoryRoot)
    const secondProcessId = 'b'.repeat(32)
    fs.writeFileSync(
      path.join(first.testsDirectory, `tests-${first.processId}-1-1-1.json`),
      JSON.stringify(createTestCyclePayload([createProjectedEvent({ 'test.name': 'first' })]))
    )
    fs.writeFileSync(
      path.join(first.testsDirectory, `tests-${secondProcessId}-1-2-1.json`),
      JSON.stringify(createTestCyclePayload([createProjectedEvent({ 'test.name': 'second' })]))
    )
    writeCompletion(first.outputRoot, first.processId, {
      eventsObserved: 1,
      eventsRetained: 1,
      payloadFiles: 1,
    }, { settings: { status: 'loaded' } })
    writeCompletion(first.outputRoot, secondProcessId, {
      eventsObserved: 1,
      eventsRetained: 1,
      payloadFiles: 1,
    }, { settings: { status: 'error' } }, ['fixture_error'])

    const output = readOfflineOutput(first.outputRoot)
    assert.strictEqual(output.completionCount, 2)
    assert.strictEqual(output.events.length, 2)
    assert.strictEqual(output.summary.eventsObserved, 2)
    assert.strictEqual(output.summary.eventsRetained, 2)
    assert.deepStrictEqual(output.summary.inputs, { settings: { status: 'error' } })
    assert.deepStrictEqual(output.summary.errors, ['fixture_error'])
  })

  it('detects a process killed after writing a payload and rejects mismatched completion evidence', () => {
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    fs.writeFileSync(
      path.join(testsDirectory, `tests-${processId}-1-1-1.json`),
      JSON.stringify(createTestCyclePayload([createProjectedEvent()]))
    )
    assert.throws(() => readOfflineOutput(outputRoot), /did not write completion evidence/)

    writeCompletion(outputRoot, processId, { eventsObserved: 2, eventsRetained: 2, payloadFiles: 1 })
    assert.throws(() => readOfflineOutput(outputRoot), /does not match retained payload artifacts/)
  })

  it('rejects the first completion record beyond the limit before reading record bodies', () => {
    const { outputRoot } = createPayloadRoot(repositoryRoot)
    const completionsDirectory = path.join(outputRoot, 'completions')
    const readdirSync = fs.readdirSync
    const filenames = Array.from(
      { length: MAX_COMPLETION_FILES + 1 },
      (_, index) => `completion-${index.toString(16).padStart(32, '0')}.json`
    )

    fs.readdirSync = directory => directory === completionsDirectory ? filenames : readdirSync(directory)
    try {
      assert.throws(() => readOfflineOutput(outputRoot), /exceeds .* completion records/)
    } finally {
      fs.readdirSync = readdirSync
    }
  })

  it('rejects malformed and hard-linked completion records', function () {
    if (process.platform === 'win32') this.skip()
    const { outputRoot, processId } = createPayloadRoot(repositoryRoot)
    const completionPath = path.join(outputRoot, 'completions', `completion-${processId}.json`)

    fs.writeFileSync(completionPath, '{}')
    assert.throws(() => readOfflineOutput(outputRoot), /Invalid offline Test Optimization exporter completion/)

    fs.unlinkSync(completionPath)
    const outside = path.join(repositoryRoot, 'outside-completion.json')
    fs.writeFileSync(outside, '{}')
    fs.linkSync(outside, completionPath)
    assert.throws(() => readOfflineOutput(outputRoot), /regular, unlinked file/)
  })

  it('rejects unsupported event shapes before normalization', () => {
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    fs.writeFileSync(
      path.join(testsDirectory, `tests-${processId}-1-1-1.json`),
      JSON.stringify(createTestCyclePayload([{ type: 'unsupported', content: { meta: {}, metrics: {} } }]))
    )
    writeCompletion(outputRoot, processId, { eventsObserved: 1, eventsRetained: 1, payloadFiles: 1 })
    assert.throws(() => readOfflineOutput(outputRoot), /unsupported event shape/)
  })

  it('rejects unsupported projected coverage fields before retaining them', () => {
    const { outputRoot, processId } = createPayloadRoot(repositoryRoot)
    const coverageDirectory = path.join(outputRoot, 'payloads', 'coverage')
    fs.writeFileSync(
      path.join(coverageDirectory, `coverage-${processId}-1-1-1.json`),
      JSON.stringify([{ test_session_id: 1, sourcePath: 'API_KEY=raw-secret-value' }])
    )
    writeCompletion(outputRoot, processId, {
      coverageFilesObserved: 1,
      coverageFilesRetained: 1,
    })

    assert.throws(() => readOfflineOutput(outputRoot), /unsupported JSON shape/)
  })

  it('applies the decoded-entry budget across payload files', () => {
    const { outputRoot, testsDirectory, processId } = createPayloadRoot(repositoryRoot)
    const eventCount = Math.floor(MAX_DECODED_COLLECTION_ENTRIES / 8)
    const payload = JSON.stringify(createTestCyclePayload(
      Array.from({ length: eventCount }, () => createProjectedEvent())
    ))
    fs.writeFileSync(path.join(testsDirectory, `tests-${processId}-1-1-1.json`), payload)
    fs.writeFileSync(path.join(testsDirectory, `tests-${processId}-1-1-2.json`), payload)
    writeCompletion(outputRoot, processId, {
      eventsObserved: eventCount * 2,
      eventsRetained: eventCount * 2,
      payloadFiles: 2,
    })
    assert.throws(() => readOfflineOutput(outputRoot), /aggregate decoded entries/)
  })
})

function createPayloadRoot (repositoryRoot) {
  const outputRoot = path.join(repositoryRoot, 'output')
  const payloadsRoot = path.join(outputRoot, 'payloads')
  const testsDirectory = path.join(payloadsRoot, 'tests')
  const completionsDirectory = path.join(outputRoot, 'completions')
  fs.mkdirSync(testsDirectory, { recursive: true })
  fs.mkdirSync(path.join(payloadsRoot, 'coverage'))
  fs.mkdirSync(completionsDirectory)
  return { outputRoot, testsDirectory, processId: 'a'.repeat(32) }
}

function createTestCyclePayload (events = []) {
  return {
    version: 1,
    events,
  }
}

function createProjectedEvent (meta = {}) {
  return { type: 'test', content: { meta, metrics: {} } }
}

function writeCompletion (outputRoot, processId, countOverrides, inputs = {}, errors = []) {
  const counts = {
    coverageFilesObserved: 0,
    coverageFilesRetained: 0,
    eventsObserved: 0,
    eventsRetained: 0,
    payloadFiles: 0,
    ...countOverrides,
  }
  fs.writeFileSync(path.join(outputRoot, 'completions', `completion-${processId}.json`), JSON.stringify({
    version: 1,
    processId,
    captureMode: 'strict',
    counts,
    inputs,
    errors,
  }))
}
