'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

describe('test optimization validation Basic Reporting diagnosis', () => {
  it('passes only with initialization, settings, a clean exit, and the complete hierarchy', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: true,
      initialized: true,
      settingsLoaded: true,
    })
    const input = getInput()
    input.framework.preflight.observedTestCount = null
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'pass')
    assert.strictEqual(result.evidence.foundationalReportingEstablished, true)
    assert.strictEqual(result.evidence.reportingPath, 'validator-direct-runner')
  })

  it('flags missing controlled initialization as a possible library bug', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: false,
      initialized: false,
      settingsLoaded: false,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.possibleLibraryBug, true)
    assert.match(result.diagnosis, /exporter did not initialize/)
  })

  it('stays incomplete when an unknown-count clean run emits no instrumented test event', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: false,
      initialized: false,
      settingsLoaded: false,
    })
    const input = getInput()
    input.framework.preflight.observedTestCount = null
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.validationIncomplete, true)
    assert.strictEqual(result.evidence.possibleLibraryBug, undefined)
    assert.match(result.diagnosis, /cannot prove that a test executed/)
  })

  it('accepts repository wrapper events only from the approved representative file', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: true,
      events: [{ type: 'test', testSourceFile: 'test/example.spec.js' }],
      initialized: true,
      settingsLoaded: true,
    })
    const input = getInput()
    input.framework.validation.selectorScope = 'instrumented_event_identity'
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'pass')
    assert.strictEqual(result.evidence.selector.verified, true)
    assert.strictEqual(result.evidence.selector.matchingTestEvents, 1)
  })

  it('keeps repository wrapper reporting incomplete when other test files ran', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: true,
      events: [
        { type: 'test', testSourceFile: 'test/example.spec.js' },
        { type: 'test', testSourceFile: 'test/other.spec.js' },
      ],
      initialized: true,
      settingsLoaded: true,
    })
    const input = getInput()
    input.framework.validation.selectorScope = 'instrumented_event_identity'
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.validationIncomplete, true)
    assert.strictEqual(result.evidence.selector.verified, false)
    assert.deepStrictEqual(result.evidence.selector.differentSourceFiles, ['test/other.spec.js'])
    assert.match(result.diagnosis, /did not prove that it honored/)
  })

  it('stays incomplete when the initialized failure cannot be reproduced cleanly', async () => {
    const { runBasicReporting } = getBasicReporting({
      cleanExitCode: 1,
      complete: false,
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.validationIncomplete, true)
    assert.match(result.diagnosis, /clean baseline changed/)
  })

  it('preserves run artifacts when instrumented validation throws', async () => {
    const artifactDirectory = path.join('/tmp', 'basic-error')
    const { runBasicReporting } = getBasicReporting({
      artifactDirectory,
      complete: false,
      initialized: false,
      settingsLoaded: false,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'error')
    assert.ok(result.artifacts.includes(path.join(artifactDirectory, 'stdout.txt')))
    assert.ok(result.artifacts.includes(path.join(artifactDirectory, 'stderr.txt')))
  })

  it('flags a repeatable initialized-only failure as a possible compatibility bug', async () => {
    const { runBasicReporting } = getBasicReporting({
      cleanExitCode: 0,
      complete: true,
      debugComplete: false,
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.possibleLibraryBug, true)
    assert.match(result.diagnosis, /possible dd-trace compatibility bug/)
  })

  it('keeps an initialized failure intermittent when the unchanged debug rerun passes', async () => {
    const { runBasicReporting } = getBasicReporting({
      cleanExitCode: 0,
      complete: false,
      debugComplete: true,
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.intermittentInstrumentedResult, true)
    assert.strictEqual(result.evidence.validationIncomplete, true)
    assert.strictEqual(result.evidence.possibleLibraryBug, undefined)
    assert.match(result.evidence.initialInstrumentedDiagnosis, /possible dd-trace adapter or compatibility bug/)
    assert.match(result.diagnosis, /unchanged DD_TRACE_DEBUG=1 rerun exited cleanly/)
  })

  it('does not clear a library finding when a wrapper debug rerun reports another test file', async () => {
    const { runBasicReporting } = getBasicReporting({
      cleanExitCode: 0,
      complete: true,
      debugComplete: true,
      debugTestSourceFiles: ['test/other.spec.js'],
      events: [{ type: 'test', testSourceFile: 'test/example.spec.js' }],
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const input = getInput()
    input.framework.validation.selectorScope = 'instrumented_event_identity'
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.possibleLibraryBug, true)
    assert.strictEqual(result.evidence.intermittentInstrumentedResult, undefined)
  })

  it('accepts an intermittent wrapper debug rerun for the same approved test file', async () => {
    const { runBasicReporting } = getBasicReporting({
      cleanExitCode: 0,
      complete: true,
      debugComplete: true,
      debugTestSourceFiles: ['test/example.spec.js'],
      events: [{ type: 'test', testSourceFile: 'test/example.spec.js' }],
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const input = getInput()
    input.framework.validation.selectorScope = 'instrumented_event_identity'
    const result = await runBasicReporting(input)

    assert.strictEqual(result.status, 'error')
    assert.strictEqual(result.evidence.intermittentInstrumentedResult, true)
    assert.strictEqual(result.evidence.possibleLibraryBug, undefined)
  })

  it('flags a passing initialized test with missing event levels as a possible adapter bug', async () => {
    const { runBasicReporting } = getBasicReporting({
      complete: false,
      initialized: true,
      settingsLoaded: true,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'fail')
    assert.deepStrictEqual(result.evidence.missingEventLevels, ['module', 'suite', 'test'])
    assert.match(result.diagnosis, /possible dd-trace adapter bug/)
  })
})

/**
 * Loads Basic Reporting with deterministic command and event evidence.
 *
 * @param {object} options simulated evidence
 * @param {string} [options.artifactDirectory] directory attached to a simulated runner error
 * @param {number} [options.cleanExitCode] clean confirmation exit code
 * @param {boolean} options.complete whether the complete event hierarchy exists
 * @param {boolean} [options.debugComplete] whether the debug rerun establishes the complete path
 * @param {number} [options.debugTestEventsWithoutSourceFile] source-less debug test event count
 * @param {string[]} [options.debugTestSourceFiles] debug test event source files
 * @param {object[]} [options.events] normalized test events
 * @param {number} [options.exitCode] initialized command exit code
 * @param {boolean} options.initialized whether the offline exporter initialized
 * @param {boolean} options.settingsLoaded whether offline settings loaded
 * @returns {object} module under test
 */
function getBasicReporting ({
  artifactDirectory,
  cleanExitCode = 0,
  complete,
  debugComplete = false,
  debugTestEventsWithoutSourceFile = 0,
  debugTestSourceFiles = [],
  events = [],
  exitCode = 0,
  initialized,
  settingsLoaded,
}) {
  const evidence = complete
    ? { testSessionEvents: 1, testModuleEvents: 1, testSuiteEvents: 1, testEvents: 1 }
    : { testSessionEvents: 1, testModuleEvents: 0, testSuiteEvents: 0, testEvents: 0 }

  return proxyquire('../../../../ci/test-optimization-validation/scenarios/basic-reporting', {
    '../command-blocker': { getCommandBlocker () {} },
    '../command-runner': {
      async runCommand () {
        return {
          artifacts: { command: '/tmp/clean/command.json' },
          exitCode: cleanExitCode,
          timedOut: false,
        }
      },
    },
    '../runner-command': {
      getBasicCommand () {
        return { argv: [process.execPath, '/repo/mocha.js', '/repo/test.js'], cwd: '/repo' }
      },
    },
    './helpers': {
      basicEventEvidence () {
        return evidence
      },
      error (framework, scenario, err, outDir = err?.artifactDirectory) {
        return {
          artifacts: ['command.json', 'stdout.txt', 'stderr.txt', 'events.ndjson', 'result.json']
            .map(filename => path.join(outDir, filename)),
          diagnosis: err.message,
          evidence: {},
          frameworkId: framework.id,
          scenario,
          status: 'error',
        }
      },
      async failWithDebugRerun (input) {
        input.evidence.debugRerun = {
          ran: true,
          commandExitCode: debugComplete ? 0 : 1,
          commandTimedOut: false,
          offlineExporterInitialized: true,
          settingsLoadedFromCache: true,
          testSessionEvents: debugComplete ? 1 : 0,
          testModuleEvents: debugComplete ? 1 : 0,
          testSuiteEvents: debugComplete ? 1 : 0,
          testEvents: debugComplete ? 1 : 0,
          testEventsWithoutSourceFile: debugTestEventsWithoutSourceFile,
          testSourceFileCount: new Set(debugTestSourceFiles).size,
          testSourceFiles: debugTestSourceFiles,
        }
        return {
          artifacts: [],
          diagnosis: input.diagnosis,
          evidence: input.evidence,
          frameworkId: input.framework.id,
          scenario: input.scenarioName,
          status: 'fail',
        }
      },
      frameworkOutDir () {
        return '/tmp/clean'
      },
      hasAllBasicEventTypes () {
        return complete
      },
      inconclusive (framework, scenario, diagnosis, resultEvidence, outDir, artifacts = []) {
        return {
          artifacts,
          diagnosis,
          evidence: { ...resultEvidence, validationIncomplete: true },
          frameworkId: framework.id,
          scenario,
          status: 'error',
        }
      },
      pass (framework, scenario, diagnosis, resultEvidence) {
        return {
          artifacts: [],
          diagnosis,
          evidence: resultEvidence,
          frameworkId: framework.id,
          scenario,
          status: 'pass',
        }
      },
      async runInstrumentedCommand () {
        if (artifactDirectory) {
          const error = new Error('simulated instrumented failure')
          error.artifactDirectory = artifactDirectory
          throw error
        }
        return {
          events,
          offline: {
            initialized,
            inputs: { settings: { status: settingsLoaded ? 'loaded' : 'missing' } },
          },
          outDir: '/tmp/basic',
          result: {
            exitCode,
            stderr: '',
            stdout: '',
            timedOut: false,
          },
        }
      },
    },
  })
}

/**
 * Builds common Basic Reporting inputs.
 *
 * @returns {object} scenario input
 */
function getInput () {
  return {
    framework: {
      framework: 'mocha',
      id: 'mocha:root',
      preflight: { exitCode: 0, ran: true, timedOut: false },
      validation: {
        selectorScope: 'bounded_direct_runner',
        testFile: '/repo/test/example.spec.js',
      },
    },
    options: { repositoryRoot: '/repo' },
    out: path.join('/tmp', 'results'),
  }
}
