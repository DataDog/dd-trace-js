'use strict'

const {
  error,
  fail,
  pass,
  prepareGeneratedScenario,
  requireGeneratedScenario,
  runInstrumentedCommand,
  testsForScenario,
} = require('./helpers')

async function runTestManagement ({ framework, intake, out, options }) {
  const scenarioName = 'test-management'
  const skipResult = requireGeneratedScenario(framework, 'test-management-target', scenarioName)
  if (skipResult) return skipResult

  let outDir
  try {
    const { scenario } = await prepareGeneratedScenario(framework, 'test-management-target')
    intake.configure({
      settings: {
        test_management: {
          enabled: true,
          attempt_to_fix_retries: 2,
        },
      },
      testManagementTests: buildQuarantinedResponse(framework, scenario),
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

    const tests = testsForScenario(run.events, scenario)
    const quarantinedTests = tests.filter(test => test.isQuarantined)
    const evidence = {
      commandExitCode: run.result.exitCode,
      matchingTestEvents: tests.length,
      quarantinedEvents: quarantinedTests.length,
      testManagementTaggedEvents: tests.filter(test => test.testManagementEnabled).length,
    }

    if (tests.length === 0) {
      return fail(framework, scenarioName, 'The test-management target test was not reported.', evidence, outDir)
    }

    if (quarantinedTests.length === 0) {
      return fail(
        framework,
        scenarioName,
        'Test Management was enabled, but the generated target was not tagged as quarantined.',
        evidence,
        outDir
      )
    }

    return pass(
      framework,
      scenarioName,
      'The generated target test was matched by Test Management and tagged as quarantined.',
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err, outDir)
  }
}

function buildQuarantinedResponse (framework, scenario) {
  const suites = {}
  for (const identity of scenario.testIdentities || []) {
    const suite = identity.suite || identity.file
    if (!suite || !identity.name) continue
    suites[suite] = suites[suite] || { tests: {} }
    suites[suite].tests[identity.name] = {
      properties: {
        quarantined: true,
      },
    }
  }

  return {
    [framework.framework]: {
      suites,
    },
  }
}

module.exports = { runTestManagement, buildQuarantinedResponse }
