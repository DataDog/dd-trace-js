'use strict'

const {
  discoverScenarioTests,
  discoveryEvidence,
  error,
  failWithDebugRerun,
  pass,
  prepareGeneratedScenario,
  requireGeneratedScenario,
  runInstrumentedCommand,
  testEventSamples,
  testsForDiscoveredScenario,
} = require('./helpers')

async function runAutoTestRetries ({ framework, intake, out, options }) {
  const scenarioName = 'atr'
  const skipResult = requireGeneratedScenario(framework, 'atr-fail-once', scenarioName)
  if (skipResult) return skipResult

  let outDir
  try {
    const { scenario } = await prepareGeneratedScenario(framework, 'atr-fail-once')
    const discovery = await discoverScenarioTests({ framework, intake, out, scenarioName, scenario, options })
    if (discovery.tests.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        configureIntake: () => intake.configure(),
        diagnosis: 'The fail-once generated test was not reported during baseline identity discovery.',
        evidence: discoveryEvidence(discovery),
        framework,
        intake,
        options,
        out,
        outDir: discovery.outDir,
        scenarioName,
      })
    }

    const configureAutoTestRetries = () => intake.configure({
      settings: {
        flaky_test_retries_enabled: true,
      },
    })
    configureAutoTestRetries()

    const run = await runInstrumentedCommand({
      framework,
      intake,
      out,
      scenarioName,
      command: scenario.runCommand,
      options,
    })
    outDir = run.outDir

    const tests = testsForDiscoveredScenario(run.events, scenario, discovery)
    const retryLikeEvents = tests.filter(test => test.isRetry || test.retryReason === 'auto_test_retry')
    const evidence = {
      ...discoveryEvidence(discovery),
      commandExitCode: run.result.exitCode,
      matchingTestEvents: tests.length,
      retryLikeEvents: retryLikeEvents.length,
      failedAttempts: tests.filter(test => test.testStatus === 'fail' || test.error === 1).length,
      passedAttempts: tests.filter(test => test.testStatus === 'pass').length,
      samples: testEventSamples(tests),
    }

    if (run.result.exitCode !== 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        configureIntake: configureAutoTestRetries,
        diagnosis: getAutoTestRetriesFailureDiagnosis(framework, evidence),
        evidence,
        framework,
        intake,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (tests.length < 2 || retryLikeEvents.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        configureIntake: configureAutoTestRetries,
        diagnosis: getAutoTestRetriesFailureDiagnosis(framework, evidence),
        evidence,
        framework,
        intake,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    return pass(
      framework,
      scenarioName,
      'The fail-once generated test was retried and the command passed.',
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err, outDir)
  }
}

function getAutoTestRetriesFailureDiagnosis (framework, evidence) {
  const frameworkName = getFrameworkName(framework)
  const retryTagSummary = getRetryTagSummary(evidence.retryLikeEvents)
  return 'Auto Test Retries was enabled, and the generated failing test was reported, but ' +
    `${frameworkName} ` +
    `did not execute a retry attempt. Observed ${formatAttemptCount(evidence.failedAttempts, 'failed')}, ` +
    `${formatAttemptCount(evidence.passedAttempts, 'passed retry')}, and ${retryTagSummary}.`
}

function formatAttemptCount (count, label) {
  return `${count} ${label} attempt${count === 1 ? '' : 's'}`
}

function getRetryTagSummary (count) {
  if (count === 0) return 'no test.retry_reason=auto_test_retry tag'
  if (count === 1) return '1 event tagged with test.retry_reason=auto_test_retry'
  return `${count} events tagged with test.retry_reason=auto_test_retry`
}

function getFrameworkName (framework) {
  return {
    cucumber: 'Cucumber',
    cypress: 'Cypress',
    jest: 'Jest',
    mocha: 'Mocha',
    playwright: 'Playwright',
    vitest: 'Vitest',
  }[framework.framework] || 'the test runner'
}

module.exports = { getAutoTestRetriesFailureDiagnosis, runAutoTestRetries }
