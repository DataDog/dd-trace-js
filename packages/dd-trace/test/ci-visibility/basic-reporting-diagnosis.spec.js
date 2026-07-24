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
    const result = await runBasicReporting(getInput())

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
 * @param {number} [options.cleanExitCode] clean confirmation exit code
 * @param {boolean} options.complete whether the complete event hierarchy exists
 * @param {number} [options.exitCode] initialized command exit code
 * @param {boolean} options.initialized whether the offline exporter initialized
 * @param {boolean} options.settingsLoaded whether offline settings loaded
 * @returns {object} module under test
 */
function getBasicReporting ({
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
