'use strict'

const {
  discoverScenarioTests,
  discoveryEvidence,
  error,
  fail,
  pass,
  prepareGeneratedScenario,
  requestsUrlIncludes,
  requireGeneratedScenario,
  runInstrumentedCommand,
  skip,
  testEventSamples,
  testsForDiscoveredScenario,
} = require('./helpers')

async function runEarlyFlakeDetection ({ framework, intake, out, options }) {
  const scenarioName = 'efd'
  const skipResult = requireGeneratedScenario(framework, 'basic-pass', scenarioName)
  if (skipResult) return skipResult

  let outDir
  try {
    const { scenario } = await prepareGeneratedScenario(framework, 'basic-pass')
    if (!scenario) {
      return skip(framework, scenarioName, 'Generated scenario "basic-pass" is not present in the manifest.')
    }

    const discovery = await discoverScenarioTests({ framework, intake, out, scenarioName, scenario, options })
    if (discovery.tests.length === 0) {
      return fail(
        framework,
        scenarioName,
        'The generated new-test candidate was not reported during baseline identity discovery.',
        discoveryEvidence(discovery),
        discovery.outDir
      )
    }

    intake.configure({
      settings: {
        early_flake_detection: {
          enabled: true,
          slow_test_retries: {
            '5s': 3,
          },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      },
      knownTests: {
        [framework.framework]: {},
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
    const retriedTests = tests.filter(test => test.isRetry || test.retryReason === 'early_flake_detection')
    const evidence = {
      ...discoveryEvidence(discovery),
      commandExitCode: run.result.exitCode,
      settingsRequested: requestsUrlIncludes(intake, '/api/v2/libraries/tests/services/setting'),
      knownTestsRequested: requestsUrlIncludes(intake, '/api/v2/ci/libraries/tests'),
      matchingTestEvents: tests.length,
      retryLikeEvents: retriedTests.length,
      earlyFlakeTaggedEvents: tests.filter(test => test.earlyFlakeEnabled).length,
      samples: testEventSamples(tests),
    }

    if (!evidence.settingsRequested || !evidence.knownTestsRequested) {
      return fail(
        framework,
        scenarioName,
        'EFD settings or known-tests endpoints were not requested.',
        evidence,
        outDir
      )
    }

    if (tests.length < 2 || retriedTests.length === 0) {
      return fail(
        framework,
        scenarioName,
        'The generated new test did not appear to be retried for Early Flake Detection.',
        evidence,
        outDir
      )
    }

    return pass(
      framework,
      scenarioName,
      'The generated new test was reported with retry evidence for Early Flake Detection.',
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err, outDir)
  }
}

module.exports = { runEarlyFlakeDetection }
