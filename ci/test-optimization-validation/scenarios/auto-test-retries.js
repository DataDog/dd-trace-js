'use strict'

const {
  discoverScenarioTests,
  discoveryEvidence,
  error,
  fail,
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
      return fail(
        framework,
        scenarioName,
        'The fail-once generated test was not reported during baseline identity discovery.',
        discoveryEvidence(discovery),
        discovery.outDir
      )
    }

    intake.configure({
      settings: {
        flaky_test_retries_enabled: true,
      },
    })

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
      return fail(
        framework,
        scenarioName,
        'The fail-once generated test still failed after ATR should have retried it.',
        evidence,
        outDir
      )
    }

    if (tests.length < 2 || retryLikeEvents.length === 0) {
      return fail(
        framework,
        scenarioName,
        'ATR was enabled, but no retry evidence was found for the fail-once generated test.',
        evidence,
        outDir
      )
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

module.exports = { runAutoTestRetries }
