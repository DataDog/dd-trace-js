'use strict'

const { getCommandBlocker } = require('./command-blocker')
const { runCommand, serializeDisplayCommand } = require('./command-runner')
const { getBasicCommand } = require('./runner-command')
const { summarizeTestOutput } = require('./scenarios/basic-reporting')
const { findInterestingLines, frameworkOutDir } = require('./scenarios/helpers')
const { getObservedTestCount } = require('./test-output')

/**
 * Runs one direct representative test without Datadog initialization.
 *
 * @param {object} input preflight inputs
 * @param {object} input.framework framework manifest entry
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @returns {Promise<{ok: boolean, failure?: object, preflight: object}>} preflight outcome
 */
async function runFrameworkPreflight ({ framework, out, options }) {
  const command = getBasicCommand(framework)
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
  const commandFailure = getCommandBlocker(result, {
    browserRequired: framework.browserRequired,
    framework: framework.framework,
    testsRan: Number.isInteger(observedTestCount) && observedTestCount > 0,
  })
  const preflight = {
    command: serializeDisplayCommand(command),
    diagnosticSummary: findInterestingLines(`${result.stdout}\n${result.stderr}`, [
      /\b(?:Abort trap|Cannot find|Error|ERR_[A-Z_]+|Failed to|Received signal|SIGABRT)\b/i,
    ], 4),
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    observedTestCount,
    ran: true,
    selectorVerification: framework.validation.selectorScope === 'instrumented_event_identity'
      ? 'requires_instrumented_event_identity'
      : 'bounded_direct_runner',
    source: 'validator',
    stderrSummary: summarizeTestOutput('', result.stderr).join('\n'),
    stdoutSummary: summarizeTestOutput(result.stdout).join('\n'),
    timedOut: result.timedOut,
    ...(commandFailure ? { commandFailure } : {}),
  }
  framework.preflight = preflight

  if (!result.timedOut && result.exitCode === 0 && observedTestCount !== 0) {
    return { ok: true, preflight }
  }

  const domain = commandFailure?.blockedByExecutionEnvironment
    ? 'execution_environment'
    : commandFailure?.localRuntimeBlocked
      ? 'local_runtime'
      : 'project_setup'
  return {
    ok: false,
    preflight,
    failure: {
      frameworkId: framework.id,
      scenario: 'basic-reporting',
      status: 'blocked',
      diagnosis: getFailureDiagnosis(result, observedTestCount, commandFailure),
      evidence: {
        commandFailure,
        domain,
        validationIncomplete: true,
      },
      artifacts: Object.values(result.artifacts),
    },
  }
}

/**
 * Explains why direct Basic Reporting could not start reliably.
 *
 * @param {object} result command result
 * @param {number|null} observedTestCount parsed test count
 * @param {object|undefined} commandFailure classified blocker
 * @returns {string} customer-facing diagnosis
 */
function getFailureDiagnosis (result, observedTestCount, commandFailure) {
  if (commandFailure?.summary) {
    return `${commandFailure.summary} Basic Reporting could not be tested reliably.`
  }
  if (result.timedOut) {
    return 'The direct representative test exceeded its approved timeout. Basic Reporting could not be tested ' +
      'reliably; rerun the test normally and confirm its prerequisites before trying again.'
  }
  if (observedTestCount === 0) {
    return 'The direct runner completed without reporting a test. The selected file may require project wrapper or ' +
      'configuration semantics, so Basic Reporting remains incomplete.'
  }
  return `The direct representative test exited ${result.exitCode} without Datadog initialization. Fix or prepare ` +
    'that test normally, then create a fresh validation plan.'
}

module.exports = { runFrameworkPreflight }
