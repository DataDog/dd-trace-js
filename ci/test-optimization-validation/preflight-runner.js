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
  const command = getDatadogCleanCommand(getBasicReportingCommand(framework))
  const outDir = frameworkOutDir(out, framework, 'preflight')
  const result = await runCommand(command, {
    artifactRoot: out,
    envMode: 'clean',
    label: `${framework.id}:preflight`,
    outDir,
    repositoryRoot: options.repositoryRoot,
    verbose: options.verbose,
  })
  const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
  const preflight = {
    ran: true,
    source: 'validator',
    command: serializeDisplayCommand(command),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    observedTestCount,
    stdoutSummary: summarizeTestOutput(result.stdout).join('\n'),
    stderrSummary: summarizeTestOutput('', result.stderr).join('\n'),
  }
  framework.preflight = preflight

  if (!result.timedOut && (result.exitCode === 0 || Number(observedTestCount) > 0)) {
    return { ok: true, preflight }
  }

  const diagnosis = result.timedOut
    ? 'The selected test command timed out during the validator-controlled uninstrumented preflight. No Test ' +
      'Optimization conclusion was reached.'
    : 'The selected test command failed before the validator could confirm that tests ran without Datadog ' +
      'initialization. Fix the project command or its setup before validating Test Optimization.'

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
        preflight,
      },
      artifacts: Object.values(result.artifacts),
    },
  }
}

module.exports = { runFrameworkPreflight }
