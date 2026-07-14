'use strict'

const path = require('path')

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

async function runTestManagement ({ framework, out, options }) {
  const scenarioName = 'test-management'
  const skipResult = requireGeneratedScenario(framework, 'test-management-target', scenarioName)
  if (skipResult) return skipResult

  let outDir
  try {
    const { scenario } = await prepareGeneratedScenario(framework, 'test-management-target')
    const discovery = await discoverScenarioTests({ framework, out, scenarioName, scenario, options })
    if (discovery.tests.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        diagnosis: 'The test-management target was not reported during baseline identity discovery.',
        evidence: discoveryEvidence(discovery),
        framework,
        options,
        out,
        outDir: discovery.outDir,
        scenarioName,
      })
    }

    const testManagementTests = buildQuarantinedResponse(framework, scenario, discovery.testIdentities)
    const fixtureConfig = {
      settings: {
        test_management: {
          enabled: true,
          attempt_to_fix_retries: 2,
        },
      },
      testManagementTests,
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
    const quarantinedTests = tests.filter(test => test.isQuarantined)
    const evidence = {
      ...discoveryEvidence(discovery),
      commandExitCode: run.result.exitCode,
      commandTimedOut: run.result.timedOut,
      settingsLoadedFromCache: run.offline.inputs.settings?.status === 'loaded',
      testManagementLoadedFromCache: run.offline.inputs.test_management?.status === 'loaded',
      configuredManagedTests: summarizeManagedTests(testManagementTests),
      matchingTestEvents: tests.length,
      quarantinedEvents: quarantinedTests.length,
      samples: testEventSamples(tests),
    }

    if (run.result.exitCode !== 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: 'The generated Test Management command reported quarantined-test evidence, but the command ' +
          `exited ${run.result.exitCode}. Test Management is only valid when the command completes successfully ` +
          'with the managed test applied.',
        evidence,
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (!evidence.settingsLoadedFromCache || !evidence.testManagementLoadedFromCache) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: 'Test Management settings or managed-test data were not loaded from the offline cache fixture.',
        evidence,
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (tests.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: 'The test-management target test was not reported.',
        evidence,
        framework,
        options,
        out,
        outDir,
        scenarioName,
      })
    }

    if (quarantinedTests.length === 0) {
      return failWithDebugRerun({
        command: scenario.runCommand,
        fixtureConfig,
        diagnosis: 'Test Management was enabled, but the generated target was not tagged as quarantined.',
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
      'The generated target test was matched by Test Management and tagged as quarantined.',
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err, outDir)
  }
}

function buildQuarantinedResponse (framework, scenario, discoveredIdentities = []) {
  const suites = {}
  const identities = [...(scenario.testIdentities || []), ...discoveredIdentities]
  for (const identity of identities) {
    for (const suite of getSuiteCandidates(identity, scenario)) {
      for (const name of getNameCandidates(identity)) {
        suites[suite] = suites[suite] || { tests: {} }
        suites[suite].tests[name] = {
          properties: {
            quarantined: true,
          },
        }
      }
    }
  }

  return {
    [framework.framework]: {
      suites,
    },
  }
}

function getSuiteCandidates (identity, scenario) {
  const candidates = new Set()
  addCandidate(candidates, identity.suite)
  addCandidate(candidates, identity.file)

  if (identity.file) {
    addCandidate(candidates, normalizePath(path.basename(identity.file)))
    if (scenario.runCommand?.cwd) {
      addCandidate(candidates, normalizePath(path.relative(scenario.runCommand.cwd, identity.file)))
    }
  }

  return [...candidates]
}

function getNameCandidates (identity) {
  const candidates = new Set()
  addCandidate(candidates, identity.name)
  if (!identity.discovered && identity.suite && identity.name && !identity.name.startsWith(`${identity.suite} `)) {
    addCandidate(candidates, `${identity.suite} ${identity.name}`)
  }
  return [...candidates]
}

function addCandidate (candidates, value) {
  if (value) candidates.add(normalizePath(value))
}

function normalizePath (value) {
  return value.replaceAll(path.sep, '/')
}

function summarizeManagedTests (testManagementTests) {
  const managed = testManagementTests && testManagementTests[Object.keys(testManagementTests)[0]]
  const suites = managed?.suites || {}
  const summary = new Map()
  for (const [suite, { tests = {} }] of Object.entries(suites)) {
    const displaySuite = path.isAbsolute(suite) ? path.basename(suite) : suite
    const testNames = summary.get(displaySuite) || new Set()
    for (const testName of Object.keys(tests)) {
      testNames.add(testName)
    }
    summary.set(displaySuite, testNames)
  }
  return [...summary.entries()].slice(0, 5).map(([suite, tests]) => ({
    suite,
    tests: [...tests].slice(0, 5),
  }))
}

module.exports = { runTestManagement, buildQuarantinedResponse }
