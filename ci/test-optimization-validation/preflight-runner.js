'use strict'

const { BLOCKER_CATEGORIES, getBlockerDomain } = require('./blocker-category')
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
  const candidates = [
    {
      localSocketRequired: framework.localSocketRequired,
      testFile: framework.validation.testFile,
    },
    ...(framework.validation.fallbackTests || []),
  ]
  const attempts = []
  let last

  for (const [index, candidate] of candidates.entries()) {
    // Fallbacks are ordered and later candidates must not run after one succeeds.
    // eslint-disable-next-line no-await-in-loop
    const attempt = await runCandidate({ framework, index, options, out, testFile: candidate.testFile })
    attempts.push(attempt.preflight)
    last = attempt
    if (!attempt.ok) {
      if (isSharedCandidateBlocker(attempt.commandFailure, framework)) break
      continue
    }

    framework.validation.testFile = candidate.testFile
    const preflight = { ...attempt.preflight, attempts, selectedTestFile: candidate.testFile }
    framework.preflight = preflight
    return { ok: true, preflight }
  }

  const { commandFailure, observedTestCount, preflight, result } = last
  const completePreflight = {
    ...preflight,
    attempts,
    selectedTestFile: undefined,
  }
  framework.preflight = completePreflight
  const blockerCategory = commandFailure?.blockerCategory ||
    (observedTestCount === 0
      ? BLOCKER_CATEGORIES.VALIDATOR_LIMITATION
      : BLOCKER_CATEGORIES.CLEAN_TEST_FAILED)
  const domain = getBlockerDomain(blockerCategory)
  const diagnosis = getFailureDiagnosis(
    result,
    observedTestCount,
    commandFailure,
    preflight.diagnosticSummary,
    framework
  )
  return {
    ok: false,
    preflight: completePreflight,
    failure: {
      frameworkId: framework.id,
      scenario: 'basic-reporting',
      status: 'blocked',
      diagnosis,
      evidence: {
        blockerCategory,
        commandFailure,
        domain,
        recommendation: commandFailure?.recommendation ||
          `Resolve the selected project test failure before retrying validation: ${diagnosis}`,
        validationIncomplete: true,
      },
      artifacts: Object.values(result.artifacts),
    },
  }
}

async function runCandidate ({ framework, index, options, out, testFile }) {
  const suffix = index === 0 ? '' : `-fallback-${index}`
  const command = getBasicCommand(framework, testFile)
  const outDir = frameworkOutDir(out, framework, `preflight${suffix}`)
  const result = await runCommand(command, {
    artifactRoot: out,
    envMode: 'clean',
    label: `${framework.id}:preflight${suffix}`,
    outDir,
    repositoryRoot: options.repositoryRoot,
    requireExecutableApproval: options.requireExecutableApproval,
    verbose: options.verbose,
  })
  const observedTestCount = getObservedTestCount(framework.framework, result.stdout, result.stderr)
  const commandFailure = getCommandBlocker(result, {
    browserRequired: framework.browserRequired,
    framework: framework.framework,
    packageJson: framework.project.packageJson,
    testsRan: Number.isInteger(observedTestCount) && observedTestCount > 0,
  })
  const preflight = {
    command: serializeDisplayCommand(command),
    diagnosticSummary: findInterestingLines(`${result.stdout}\n${result.stderr}`, [
      /\b(?:Abort trap|Cannot find|Error|TypeError|ReferenceError|RangeError|SyntaxError|ERR_[A-Z_]+|FAIL|Failed to|No tests found|Received signal|SIGABRT)\b/i,
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
    testFile,
    timedOut: result.timedOut,
    ...(commandFailure ? { commandFailure } : {}),
  }
  return {
    commandFailure,
    observedTestCount,
    ok: !result.timedOut && result.exitCode === 0 && observedTestCount !== 0,
    preflight,
    result,
  }
}

/**
 * Explains why direct Basic Reporting could not start reliably.
 *
 * @param {object} result command result
 * @param {number|null} observedTestCount parsed test count
 * @param {object|undefined} commandFailure classified blocker
 * @param {string[]} diagnosticSummary bounded diagnostic lines
 * @param {object} framework framework manifest entry
 * @returns {string} customer-facing diagnosis
 */
function getFailureDiagnosis (result, observedTestCount, commandFailure, diagnosticSummary, framework) {
  const sharedPrerequisite = !commandFailure && framework.allCandidatesRequireLocalSocket
    ? ' Every approved candidate appears to require localhost, so retry in the project environment where its ' +
      'listener-based tests normally pass.'
    : ''
  if (commandFailure?.summary) {
    return `${commandFailure.summary} Basic Reporting could not be tested reliably.${sharedPrerequisite}`
  }
  if (result.timedOut) {
    return 'The direct representative test exceeded its approved timeout. Basic Reporting could not be tested ' +
      'reliably; rerun the test normally and confirm its prerequisites before trying again.'
  }
  if (observedTestCount === 0) {
    return 'The direct runner completed without reporting a test. The selected file may require project wrapper or ' +
      'configuration semantics, so Basic Reporting remains incomplete.'
  }
  if (diagnosticSummary.length > 0) {
    return `The direct representative test exited ${result.exitCode} without Datadog initialization. ` +
      `The first reported issue was: ${diagnosticSummary[0]}${sharedPrerequisite}`
  }
  return `The direct representative test exited ${result.exitCode} without Datadog initialization. Fix or prepare ` +
    `that test normally, then create a fresh validation plan.${sharedPrerequisite}`
}

// Do not try fallbacks when every disclosed candidate shares the same prerequisite.
function isSharedCandidateBlocker (commandFailure, framework) {
  if (!commandFailure) return false
  if (commandFailure.kind === 'local-test-socket-blocked') {
    return framework.allCandidatesRequireLocalSocket === true
  }
  return commandFailure.kind.endsWith('-browser-launch-blocked') ||
    [
      'cucumber-browser-missing',
      'cypress-runtime-missing',
      'playwright-browser-missing',
      'project-command-environment-missing',
      'test-runner-command-missing',
      'vitest-browser-provider-missing',
    ].includes(commandFailure.kind)
}

module.exports = { runFrameworkPreflight }
