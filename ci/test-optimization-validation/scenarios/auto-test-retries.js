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
  skip,
  testEventSamples,
  testsForDiscoveredScenario,
} = require('./helpers')

async function runAutoTestRetries ({ framework, out, options }) {
  const scenarioName = 'atr'
  if (isUnsupportedCucumberVersion(framework)) {
    return skip(
      framework,
      scenarioName,
      'Auto Test Retries validation requires @cucumber/cucumber >=8.0.0. Basic Reporting and other eligible ' +
        `checks remain available for detected version ${framework.frameworkVersion}.`,
      {
        featureEligibility: {
          eligible: false,
          blockedBy: 'framework-version',
          reasonCode: 'cucumber-atr-version-unsupported',
          requiredVersion: '>=8.0.0',
          detectedVersion: framework.frameworkVersion,
          scenario: scenarioName,
        },
      }
    )
  }
  const skipResult = requireGeneratedScenario(framework, 'atr-fail-once', scenarioName)
  if (skipResult) return skipResult

  let outDir
  try {
    const { scenario } = await prepareGeneratedScenario(framework, 'atr-fail-once')
    const discovery = await discoverScenarioTests({ framework, out, scenarioName, scenario, options })
    if (discovery.tests.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        diagnosis: 'The fail-once generated test was not reported during baseline identity discovery.',
        evidence: discoveryEvidence(discovery),
        framework,
        options,
        out,
        outDir: discovery.outDir,
        scenarioName,
      })
    }

    const fixtureConfig = {
      settings: {
        flaky_test_retries_enabled: true,
      },
    }

    const run = await runInstrumentedCommand({
      framework,
      out,
      scenarioName,
      command: scenario.runCommand,
      options,
      fixtureConfig,
    })
    outDir = run.outDir

    const tests = testsForDiscoveredScenario(run.events, scenario, discovery)
    const autoTestRetryEvents = tests.filter(test => test.retryReason === 'auto_test_retry')
    const externalRetryEvents = tests.filter(test => test.isRetry && test.retryReason !== 'auto_test_retry')
    const evidence = {
      ...discoveryEvidence(discovery),
      commandExitCode: run.result.exitCode,
      settingsLoadedFromCache: run.offline.inputs.settings?.status === 'loaded',
      matchingTestEvents: tests.length,
      autoTestRetryEvents: autoTestRetryEvents.length,
      externalRetryEvents: externalRetryEvents.length,
      failedAttempts: tests.filter(test => test.testStatus === 'fail' || test.error === 1).length,
      passedAttempts: tests.filter(test => test.testStatus === 'pass').length,
      samples: testEventSamples(tests),
    }

    if (!evidence.settingsLoadedFromCache) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: 'Auto Test Retries settings were not loaded from the offline cache fixture.',
        evidence,
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (run.result.exitCode !== 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: getAutoTestRetriesFailureDiagnosis(framework, evidence),
        evidence,
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (tests.length < 2 || autoTestRetryEvents.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: getAutoTestRetriesFailureDiagnosis(framework, evidence),
        evidence,
        framework,
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

function isUnsupportedCucumberVersion (framework) {
  if (framework.framework !== 'cucumber') return false
  const major = Number.parseInt(String(framework.frameworkVersion || '').split('.')[0], 10)
  return Number.isInteger(major) && major < 8
}

function getAutoTestRetriesFailureDiagnosis (framework, evidence) {
  const frameworkName = getFrameworkName(framework)
  const retryTagSummary = getRetryTagSummary(evidence.autoTestRetryEvents)
  if (evidence.autoTestRetryEvents > 0 || evidence.failedAttempts > 1) {
    return 'Auto Test Retries executed for the generated test, but every attempt failed. Observed ' +
      `${formatAttemptCount(evidence.failedAttempts, 'failed')}, ` +
      `${formatAttemptCount(evidence.passedAttempts, 'passed retry')}, and ${retryTagSummary}. ` +
      'Review the generated test failure because retry execution itself was observed.'
  }
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
