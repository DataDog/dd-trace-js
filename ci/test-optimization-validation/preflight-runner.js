'use strict'

const { getCommandBlocker } = require('./command-blocker')
const { runCommand, serializeDisplayCommand } = require('./command-runner')
const { getDatadogCleanCommand, getLocalValidationCommand } = require('./local-command')
const { summarizeTestOutput } = require('./scenarios/basic-reporting')
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
  const candidates = getLocalTestCandidates(framework)
  const attempts = []
  const artifacts = []

  for (const [index, candidate] of candidates.entries()) {
    const maxTestCount = candidate.maxTestCount ?? framework.preflight.maxTestCount
    const command = getDatadogCleanCommand(getLocalValidationCommand(framework, candidate.command))
    const scenarioName = candidates.length === 1 ? 'preflight' : `preflight-candidate-${index + 1}`
    const outDir = frameworkOutDir(out, framework, scenarioName)
    // Candidates are disclosed and executable-bound in the approval plan before this loop begins.
    // eslint-disable-next-line no-await-in-loop
    const result = await runCommand(command, {
      artifactRoot: out,
      envMode: 'clean',
      label: `${framework.id}:${scenarioName}`,
      outDir,
      repositoryRoot: options.repositoryRoot,
      requireExecutableApproval: options.requireExecutableApproval,
      verbose: options.verbose,
    })
    artifacts.push(...Object.values(result.artifacts))
    const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
    const testCountKnown = Number.isInteger(observedTestCount)
    const scopeMatched = testCountKnown && observedTestCount >= 1 && observedTestCount <= maxTestCount
    const commandFailure = getCommandBlocker(result, {
      framework: framework.framework,
      testsRan: observedTestCount > 0,
    })
    const attempt = {
      candidateIndex: index,
      sourceFile: candidate.sourceFile,
      command: serializeDisplayCommand(command),
      maxTestCount,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      observedTestCount,
      scopeMatched,
      rejectionReason: commandFailure?.summary || (!result.timedOut && result.exitCode === 0 && scopeMatched
        ? undefined
        : getPreflightFailureDiagnosis({ maxTestCount, observedTestCount, result, testCountKnown })),
      stdoutSummary: summarizeTestOutput(result.stdout).join('\n'),
      stderrSummary: summarizeTestOutput('', result.stderr).join('\n'),
      ...(commandFailure ? { commandFailure } : {}),
    }
    attempts.push(attempt)

    if (!result.timedOut && result.exitCode === 0 && scopeMatched) {
      framework.existingTestCommand = candidate.command
      const preflight = {
        ...attempt,
        ran: true,
        source: 'validator',
        selectedCandidateIndex: index,
        attempts,
      }
      framework.preflight = preflight
      return { ok: true, preflight }
    }
  }

  const singleAttempt = attempts.length === 1 ? attempts[0] : {}
  const preflight = {
    ...singleAttempt,
    ran: true,
    source: 'validator',
    allCandidatesRejected: true,
    attempts,
  }
  framework.preflight = preflight
  const commandFailures = attempts.map(attempt => attempt.commandFailure).filter(Boolean)
  const executionBlocked = commandFailures.length === attempts.length && commandFailures.length > 0
  const commonCommandFailure = executionBlocked && commandFailures.every(commandFailure => {
    return commandFailure.kind === commandFailures[0].kind
  })
    ? commandFailures[0]
    : undefined
  const representativeScopeMismatch = attempts.some(attempt => {
    return Number.isInteger(attempt.observedTestCount) && attempt.observedTestCount > attempt.maxTestCount
  })
  const attempted = attempts.map((attempt, index) => {
    return `candidate ${index + 1}: ${attempt.rejectionReason || 'did not establish a runnable test scope'}`
  }).join(' ')

  return {
    ok: false,
    preflight,
    failure: {
      frameworkId: framework.id,
      scenario: 'basic-reporting',
      status: executionBlocked ? 'blocked' : 'error',
      diagnosis: `None of the ${candidates.length} approved whole-file test candidates established a bounded ` +
        `runnable command. ${attempted} No Test Optimization conclusion was reached.`,
      evidence: {
        validationIncomplete: true,
        domain: executionBlocked ? 'execution_environment' : 'validator_adapter',
        representativeScopeMismatch,
        ...(commonCommandFailure ? { commandFailure: commonCommandFailure } : {}),
        candidateAttempts: attempts,
      },
      artifacts,
    },
  }
}

/**
 * Returns local candidates in their approved order, preserving manifests created before fallback support.
 *
 * @param {object} framework manifest framework entry
 * @returns {Array<{command: object, maxTestCount: number, sourceFile?: string}>} approved candidates
 */
function getLocalTestCandidates (framework) {
  if (Array.isArray(framework.localTestCandidates) && framework.localTestCandidates.length > 0) {
    return framework.localTestCandidates
  }
  return [{
    command: framework.existingTestCommand,
    maxTestCount: framework.preflight.maxTestCount,
  }]
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
  return `The selected test command ran ${observedTestCount} test${observedTestCount === 1 ? '' : 's'} but exited ` +
    `${result.exitCode} without Datadog initialization. Fix the failing project test or its setup before ` +
    'validating Test Optimization.'
}

module.exports = { runFrameworkPreflight }
