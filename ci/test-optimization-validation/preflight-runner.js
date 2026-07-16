'use strict'

const { runCommand, serializeDisplayCommand } = require('./command-runner')
const { getDatadogCleanCommand } = require('./local-command')
const { getBasicReportingCommand, summarizeTestOutput } = require('./scenarios/basic-reporting')
const { frameworkOutDir } = require('./scenarios/helpers')
const { getObservedTestCount } = require('./test-output')

/**
 * Runs the selected Basic Reporting command without inherited Datadog initialization.
 *
 * @param {object} input preflight inputs
 * @param {object} input.framework manifest framework entry
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @returns {Promise<{ok: boolean, failure?: object, preflight: object}>} preflight outcome
 */
async function runFrameworkPreflight ({ framework, out, options }) {
  const maxTestCount = framework.preflight.maxTestCount
  const command = getDatadogCleanCommand(getBasicReportingCommand(framework))
  const outDir = frameworkOutDir(out, framework, 'preflight')
  const result = await runCommand(command, {
    artifactRoot: out,
    envMode: 'clean',
    label: `${framework.id}:preflight`,
    outDir,
    repositoryRoot: options.repositoryRoot,
    requireExecutableApproval: options.requireExecutableApproval,
    verbose: options.verbose,
  })
  const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
  const preflight = {
    ran: true,
    source: 'validator',
    maxTestCount,
    command: serializeDisplayCommand(command),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    observedTestCount,
    stdoutSummary: summarizeTestOutput(result.stdout).join('\n'),
    stderrSummary: summarizeTestOutput('', result.stderr).join('\n'),
  }
  framework.preflight = preflight

  const testCountKnown = Number.isInteger(observedTestCount)
  const scopeMatched = testCountKnown && observedTestCount >= 1 && observedTestCount <= maxTestCount
  preflight.scopeMatched = scopeMatched

  if (!result.timedOut && scopeMatched && (result.exitCode === 0 || observedTestCount > 0)) {
    return { ok: true, preflight }
  }

  const diagnosis = getPreflightFailureDiagnosis({
    maxTestCount,
    observedTestCount,
    result,
    testCountKnown,
  })

  return {
    ok: false,
    preflight,
    failure: {
      frameworkId: framework.id,
      scenario: 'basic-reporting',
      status: 'error',
      diagnosis,
      evidence: {
        commandExitCode: result.exitCode,
        commandTimedOut: result.timedOut,
        representativeScopeMismatch: !scopeMatched,
        preflight,
      },
      artifacts: Object.values(result.artifacts),
    },
  }
}

/**
 * Produces the narrowest diagnosis supported by a failed clean preflight.
 *
 * @param {object} input diagnosis inputs
 * @param {number} input.maxTestCount approved representative test limit
 * @param {number|undefined} input.observedTestCount parsed test count
 * @param {object} input.result command result
 * @param {boolean} input.testCountKnown whether the test count was parsed
 * @returns {string} customer-facing diagnosis
 */
function getPreflightFailureDiagnosis ({ maxTestCount, observedTestCount, result, testCountKnown }) {
  if (result.timedOut) {
    return 'The selected test command timed out during the validator-controlled uninstrumented preflight. No Test ' +
      'Optimization conclusion was reached.'
  }
  if (!testCountKnown) {
    return 'The validator could not determine how many tests the selected command ran, so it could not confirm ' +
      `the approved representative scope of at most ${maxTestCount} tests. Select a command whose output ` +
      'reports the test count before validating Test Optimization.'
  }
  if (observedTestCount > maxTestCount) {
    return `The selected command ran ${observedTestCount} tests, exceeding the approved representative scope ` +
      `of at most ${maxTestCount}. Select a narrower test command before validating Test Optimization.`
  }
  if (observedTestCount < 1) {
    return 'The selected command did not report any tests. Select a runnable representative before validating ' +
      'Test Optimization.'
  }
  return 'The selected test command failed before the validator could confirm that tests ran without Datadog ' +
    'initialization. Fix the project command or its setup before validating Test Optimization.'
}

module.exports = { runFrameworkPreflight }
