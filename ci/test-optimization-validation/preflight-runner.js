'use strict'

const { getCommandBlocker } = require('./command-blocker')
const { runCommand, serializeDisplayCommand } = require('./command-runner')
const { getDatadogCleanCommand, getLocalValidationCommand } = require('./local-command')
const { summarizeTestOutput } = require('./scenarios/basic-reporting')
const { findInterestingLines, frameworkOutDir } = require('./scenarios/helpers')
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
function runFrameworkPreflight ({ framework, out, options }) {
  return runCandidatePreflight({
    candidates: getLocalTestCandidates(framework),
    framework,
    out,
    options,
    scenarioPrefix: 'preflight',
    selectPrimary: true,
  })
}

/**
 * Runs the disclosed direct-runner isolation command without Datadog initialization.
 *
 * @param {object} input preflight inputs
 * @param {object} input.framework manifest framework entry
 * @param {object} input.isolationTestCandidate approved isolation candidate
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @returns {Promise<{ok: boolean, failure?: object, preflight: object}>} preflight outcome
 */
function runIsolationPreflight ({ framework, isolationTestCandidate, out, options }) {
  if (!isolationTestCandidate) {
    return {
      ok: false,
      preflight: { ran: false, reason: 'No equivalent direct-runner isolation command was approved.' },
    }
  }
  return runCandidatePreflight({
    candidates: [isolationTestCandidate],
    framework,
    out,
    options,
    scenarioPrefix: 'isolation-preflight',
    selectPrimary: false,
  })
}

/**
 * Runs approved clean candidates until one completes successfully.
 *
 * @param {object} input candidate preflight inputs
 * @param {object[]} input.candidates approved candidates
 * @param {object} input.framework manifest framework entry
 * @param {string} input.out validation output directory
 * @param {object} input.options validator options
 * @param {string} input.scenarioPrefix artifact scenario prefix
 * @param {boolean} input.selectPrimary whether to select the passing project candidate
 * @returns {Promise<{ok: boolean, failure?: object, preflight: object}>} preflight outcome
 */
async function runCandidatePreflight ({ candidates, framework, out, options, scenarioPrefix, selectPrimary }) {
  const attempts = []
  const artifacts = []

  for (const [index, candidate] of candidates.entries()) {
    const command = getDatadogCleanCommand(getLocalValidationCommand(framework, candidate.command))
    const scenarioName = candidates.length === 1 ? scenarioPrefix : `${scenarioPrefix}-candidate-${index + 1}`
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
    const testCountAccepted = !testCountKnown || observedTestCount > 0
    const commandFailure = getCommandBlocker(result, {
      browserRequired: framework.browserRequired,
      framework: framework.framework,
      testsRan: observedTestCount > 0,
    })
    const attempt = {
      candidateIndex: index,
      origin: candidate.origin || 'project',
      sourceFile: candidate.sourceFile,
      command: serializeDisplayCommand(command),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      observedTestCount,
      testCountKnown,
      testCountAccepted,
      rejectionReason: commandFailure?.summary || (!result.timedOut && result.exitCode === 0 && testCountAccepted
        ? undefined
        : getPreflightFailureDiagnosis({ observedTestCount, result, testCountKnown })),
      stdoutSummary: summarizeTestOutput(result.stdout).join('\n'),
      stderrSummary: summarizeTestOutput('', result.stderr).join('\n'),
      diagnosticSummary: findInterestingLines(`${result.stdout}\n${result.stderr}`, [
        /\b(?:Abort trap|Cannot find|Error|ERR_[A-Z_]+|Failed to|Package subpath|Received signal|SIGABRT)\b/i,
      ], 4),
      ...(commandFailure ? { commandFailure } : {}),
    }
    attempts.push(attempt)

    if (!result.timedOut && result.exitCode === 0 && testCountAccepted) {
      if (selectPrimary) framework.existingTestCommand = candidate.command
      const preflight = {
        ...attempt,
        ran: true,
        source: 'validator',
        selectedCandidateIndex: index,
        attempts,
      }
      if (selectPrimary) framework.preflight = preflight
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
  if (selectPrimary) framework.preflight = preflight
  const commandFailures = attempts.map(attempt => attempt.commandFailure).filter(Boolean)
  const allAttemptsClassified = commandFailures.length === attempts.length && commandFailures.length > 0
  const executionBlocked = allAttemptsClassified && commandFailures.every(commandFailure => {
    return commandFailure.blockedByExecutionEnvironment === true
  })
  const projectSetupBlocked = allAttemptsClassified && commandFailures.every(commandFailure => {
    return commandFailure.toolchainBlocked === true
  })
  const localRuntimeBlocked = allAttemptsClassified && commandFailures.every(commandFailure => {
    return commandFailure.localRuntimeBlocked === true
  })
  const projectBaselineFailed = attempts.some(attempt => {
    return !attempt.commandFailure && attempt.timedOut !== true && attempt.testCountAccepted === true &&
      Number.isInteger(attempt.exitCode) && attempt.exitCode !== 0
  })
  const projectCommandTimedOut = attempts.some(attempt => attempt.timedOut === true)
  const projectBlocked = projectSetupBlocked || projectBaselineFailed || projectCommandTimedOut
  const commonCommandFailure = (executionBlocked || projectSetupBlocked || localRuntimeBlocked) &&
    commandFailures.every(commandFailure => {
      return commandFailure.kind === commandFailures[0].kind
    })
    ? commandFailures[0]
    : undefined
  const attempted = commonCommandFailure
    ? `${candidates.length === 1 ? 'The approved test command' : `All ${candidates.length} approved test commands`} ` +
      `failed for the same reason: ${commonCommandFailure.summary.replace(
        /\s*No Test Optimization conclusion was reached\.\s*$/,
        ''
      )}`
    : attempts.map((attempt, index) => {
      const reason = attempt.rejectionReason || 'did not establish a runnable test command'
      return `candidate ${index + 1}: ${reason.replace(
        /\s*No Test Optimization conclusion was reached\.\s*$/,
        ''
      )}`
    }).join(' ')
  let domain = 'validator_adapter'
  if (executionBlocked) {
    domain = 'execution_environment'
  } else if (localRuntimeBlocked) {
    domain = 'local_runtime'
  } else if (projectBlocked) {
    domain = 'project_setup'
  }

  return {
    ok: false,
    preflight,
    failure: {
      frameworkId: framework.id,
      scenario: 'basic-reporting',
      status: executionBlocked || localRuntimeBlocked || projectBlocked ? 'blocked' : 'error',
      diagnosis: `${attempted} Basic Reporting could not be tested reliably.`,
      evidence: {
        validationIncomplete: true,
        domain,
        localRuntimeBlocked,
        projectBaselineFailed,
        projectCommandTimedOut,
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
 * @returns {Array<{command: object, sourceFile?: string}>} approved candidates
 */
function getLocalTestCandidates (framework) {
  if (Array.isArray(framework.localTestCandidates) && framework.localTestCandidates.length > 0) {
    return framework.localTestCandidates
  }
  return [{
    command: framework.existingTestCommand,
  }]
}

/**
 * Produces the narrowest diagnosis supported by a failed clean preflight.
 *
 * @param {object} input diagnosis inputs
 * @param {number|undefined} input.observedTestCount parsed test count
 * @param {object} input.result command result
 * @param {boolean} input.testCountKnown whether the test count was parsed
 * @returns {string} customer-facing diagnosis
 */
function getPreflightFailureDiagnosis ({ observedTestCount, result, testCountKnown }) {
  if (result.timedOut) {
    return 'The selected test command did not finish within the approved timeout. Basic Reporting could not be ' +
      'tested reliably with this project command.'
  }
  if (testCountKnown && observedTestCount < 1) {
    return 'The selected command did not report any tests. Select a runnable representative before validating ' +
      'Test Optimization.'
  }
  const testSummary = testCountKnown
    ? `ran ${observedTestCount} test${observedTestCount === 1 ? '' : 's'}`
    : 'completed without a readable test count'
  return `The selected test command ${testSummary} but exited ${result.exitCode} without Datadog initialization. ` +
    'Fix the failing project test or its setup before validating Test Optimization.'
}

module.exports = { runFrameworkPreflight, runIsolationPreflight }
