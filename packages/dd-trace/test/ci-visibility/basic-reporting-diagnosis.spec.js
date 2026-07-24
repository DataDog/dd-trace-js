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
      exitCode: 1,
      initialized: true,
      settingsLoaded: true,
    })
    const result = await runBasicReporting(getInput())

    assert.strictEqual(result.status, 'fail')
    assert.strictEqual(result.evidence.possibleLibraryBug, true)
    assert.match(result.diagnosis, /possible dd-trace compatibility bug/)
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
 * @param {number} [options.exitCode] initialized command exit code
 * @param {boolean} options.initialized whether the offline exporter initialized
 * @param {boolean} options.settingsLoaded whether offline settings loaded
 * @returns {object} module under test
 */
function getBasicReporting ({
  artifactDirectory,
  cleanExitCode = 0,
  complete,
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
          events: [],
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
    },
    options: { repositoryRoot: '/repo' },
    out: path.join('/tmp', 'results'),
  }
}
