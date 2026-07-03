'use strict'

const fs = require('fs')
const path = require('path')

const { buildCiWiringEnv, runCommand } = require('../command-runner')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { normalizeRequests } = require('../payload-normalizer')
const { getMissingEventDiagnosis, summarizeTestOutput } = require('./basic-reporting')
const {
  basicEventEvidence,
  error,
  fail,
  frameworkOutDir,
  hasAllBasicEventTypes,
  pass,
  skip,
} = require('./helpers')

async function runCiWiring ({ manifest, framework, intake, out, options, basicResult }) {
  const scenarioName = 'ci-wiring'

  try {
    const command = framework.ciWiringCommand
    if (!command) return getMissingCiWiringCommandResult(framework, manifest)

    const outDir = frameworkOutDir(out, framework, scenarioName)
    intake.configure()
    intake.resetRequests()

    const result = await runCommand(command, {
      env: buildCiWiringEnv({ intake }),
      envMode: 'clean',
      outDir,
      label: `${framework.id}:${scenarioName}`,
      verbose: options.verbose,
    })

    await wait(1000)
    const events = normalizeRequests(intake.requests)
    fs.writeFileSync(path.join(outDir, 'events.ndjson'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)

    const evidence = {
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: command.description,
      commandOutputSummary: summarizeTestOutput(result.stdout, result.stderr),
      ciWiring: framework.ciWiring,
      forcedLocalBasicReporting: summarizeBasicReportingResult(basicResult),
      preflight: summarizePreflight(framework.preflight),
      ...basicEventEvidence(events),
    }

    if (!hasAllBasicEventTypes(events)) {
      evidence.eventLevelFailure = getCiWiringEventFailure({ framework, result, evidence, basicResult })
      return fail(framework, scenarioName, evidence.eventLevelFailure.summary, evidence, outDir)
    }

    if (result.exitCode === 0) {
      return pass(
        framework,
        scenarioName,
        'CI wiring emitted session, module, suite, and test events without validator-injected preloads.',
        evidence,
        outDir
      )
    }

    if (matchesPreflightExitCode(framework.preflight, result.exitCode)) {
      evidence.commandExitMatchesPreflight = true
      return pass(
        framework,
        scenarioName,
        'CI wiring emitted session, module, suite, and test events without validator-injected preloads. ' +
          `The command exited ${result.exitCode}, matching the dd-trace-less preflight run.`,
        evidence,
        outDir
      )
    }

    evidence.commandExitMatchesPreflight = false
    return fail(
      framework,
      scenarioName,
      `CI wiring emitted Test Optimization events, but the command exited ${result.exitCode}.`,
      evidence,
      outDir
    )
  } catch (err) {
    return error(framework, scenarioName, err)
  }
}

function getMissingCiWiringCommandResult (framework, manifest) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return fail(framework, 'ci-wiring', contradiction.reason, {
      ciWiring: framework.ciWiring,
      ciDiscovery: contradiction.ciDiscovery,
      recommendation: contradiction.recommendation,
    })
  }

  const ciWiring = framework.ciWiring
  const status = ciWiring?.status === 'fail' ? 'fail' : 'skip'
  const diagnosis = ciWiring?.diagnosis ||
    ciWiring?.reason ||
    'No replayable CI wiring command was provided in the manifest.'
  const evidence = {
    ciWiring,
    recommendation: 'Add ciWiringCommand to the manifest when a CI test step can be safely replayed locally.',
  }

  if (status === 'fail') return fail(framework, 'ci-wiring', diagnosis, evidence)
  return skip(framework, 'ci-wiring', diagnosis, evidence)
}

function getCiWiringEventFailure ({ framework, result, evidence, basicResult }) {
  const localFailure = getMissingEventDiagnosis({ framework, result, evidence })
  const testsRan = commandOutputShowsTestsRan(evidence.commandOutputSummary)

  if (testsRan) {
    return {
      ...localFailure,
      kind: 'ci-wiring-no-test-optimization-events',
      summary: getCiWiringTestsRanSummary({ basicResult }),
      recommendation: getCiWiringTestsRanRecommendation({ basicResult }),
    }
  }

  return {
    ...localFailure,
    summary: 'CI wiring did not emit Test Optimization events without validator-injected preloads. ' +
      localFailure.summary,
    recommendation: 'Verify the selected CI step is the real test step and that CI-provided Test Optimization ' +
      'initialization reaches the final test process.',
  }
}

function getCiWiringTestsRanSummary ({ basicResult }) {
  const summary = 'The test command used by the CI job ran tests, but no Test Optimization events reached ' +
    'the mock intake. The Datadog environment configured for the CI job does not reach dd-trace in the ' +
    'final test process.'

  if (basicResult?.status === 'pass') {
    return `${summary} Forced local Basic Reporting passed, so when the validator injects the required ` +
      'Test Optimization environment directly into the selected test command, events are reported correctly.'
  }

  return summary
}

function getCiWiringTestsRanRecommendation ({ basicResult }) {
  const recommendation = 'Verify that the CI workflow sets NODE_OPTIONS with dd-trace/ci/init for the final ' +
    'test runner, and that any package manager, monorepo runner, or wrapper preserves it.'

  if (basicResult?.status === 'pass') {
    return `${recommendation} Compare the passing forced-local command with the CI job command to find where ` +
      'the Datadog environment is dropped.'
  }

  return recommendation
}

function summarizeBasicReportingResult (basicResult) {
  if (!basicResult) {
    return {
      ran: false,
      reason: 'Forced local Basic Reporting was not run before CI wiring.',
    }
  }

  return {
    ran: true,
    status: basicResult.status,
    diagnosis: basicResult.diagnosis,
  }
}

function commandOutputShowsTestsRan (lines) {
  return lines.some(line => {
    return /\b\d+\s+(?:passing|passed)\b/i.test(line) ||
      /\btests?\b.*\bpassed\b/i.test(line) ||
      /\bSuccessfully ran target\b.*\btest\b/i.test(line) ||
      /\bsuccess:\s*[1-9]\d*\b/i.test(line) ||
      /\bTasks:\s*[1-9]\d*\s+successful\b/i.test(line)
  })
}

function matchesPreflightExitCode (preflight, exitCode) {
  return preflight?.ran === true &&
    Number.isInteger(preflight.exitCode) &&
    preflight.exitCode === exitCode
}

function summarizePreflight (preflight) {
  if (!preflight || preflight.ran !== true) {
    return {
      ran: false,
      reason: 'No dd-trace-less preflight result was recorded in the manifest.',
    }
  }

  return {
    ran: true,
    exitCode: preflight.exitCode,
    observedTestCount: preflight.observedTestCount,
    stdoutSummary: preflight.stdoutSummary,
    stderrSummary: preflight.stderrSummary,
  }
}

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  runCiWiring,
}
