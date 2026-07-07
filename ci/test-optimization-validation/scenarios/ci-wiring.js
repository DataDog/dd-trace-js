'use strict'

const fs = require('fs')
const path = require('path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiWiringEnv, runCommand } = require('../command-runner')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { runInitializationProbe } = require('../init-probe')
const { normalizeRequests } = require('../payload-normalizer')
const { sanitizeForReport } = require('../redaction')
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
    const sanitizedEvents = sanitizeForReport(events)
    fs.writeFileSync(
      path.join(outDir, 'events.ndjson'),
      sanitizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n'
    )
    fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(sanitizeForReport(result), null, 2)}\n`)

    const evidence = {
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: command.description,
      commandOutputSummary: summarizeTestOutput(result.stdout, result.stderr),
      ciCommandCandidate: buildCiCommandCandidate(framework),
      ciWiring: framework.ciWiring,
      forcedLocalBasicReporting: summarizeBasicReportingResult(basicResult),
      preflight: summarizePreflight(framework.preflight),
      ...basicEventEvidence(events),
    }

    if (!hasAllBasicEventTypes(events)) {
      const probe = await maybeRunInitializationProbe({ command, framework, intake, options, outDir, result, evidence })
      if (probe.summary) evidence.initializationProbe = probe.summary
      evidence.monorepoFindings = getMonorepoFindings({ framework, command, probe: probe.summary })
      evidence.eventLevelFailure = getCiWiringEventFailure({ framework, result, evidence, basicResult })
      return fail(framework, scenarioName, evidence.eventLevelFailure.summary, evidence, outDir, probe.artifacts)
    }

    if (result.exitCode === 0) {
      return pass(
        framework,
        scenarioName,
        'The CI test command emitted session, module, suite, and test events with the initialization configured ' +
          'by CI.',
        evidence,
        outDir
      )
    }

    if (matchesPreflightExitCode(framework.preflight, result.exitCode)) {
      evidence.commandExitMatchesPreflight = true
      return pass(
        framework,
        scenarioName,
        'The CI test command emitted session, module, suite, and test events with the initialization configured ' +
          'by CI. ' +
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

async function maybeRunInitializationProbe ({ command, framework, intake, options, outDir, result, evidence }) {
  if (result.timedOut === true) return {}
  if (!commandOutputShowsTestsRan(evidence.commandOutputSummary)) return {}

  try {
    return await runInitializationProbe({
      command,
      framework,
      intake,
      options,
      outDir,
    })
  } catch (err) {
    return {
      summary: {
        ran: false,
        error: err && err.message ? err.message : String(err),
      },
    }
  } finally {
    intake.resetRequests()
  }
}

function getMissingCiWiringCommandResult (framework, manifest) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return fail(framework, 'ci-wiring', contradiction.reason, {
      ciCommandCandidate: buildCiCommandCandidate(framework),
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
    ciCommandCandidate: buildCiCommandCandidate(framework),
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
      summary: getCiWiringTestsRanSummary({ basicResult, evidence, framework }),
      recommendation: getCiWiringTestsRanRecommendation({ basicResult, evidence }),
    }
  }

  return {
    ...localFailure,
    summary: 'The CI test command did not emit Test Optimization events with the initialization configured by CI. ' +
      localFailure.summary,
    recommendation: 'Verify the selected CI step is the real test step and that CI-provided Test Optimization ' +
      'initialization reaches the final test process.',
  }
}

function getCiWiringTestsRanSummary ({ basicResult, evidence, framework }) {
  const summary = 'The test command used by the CI job was identified and ran tests. When it ran with only the ' +
    'environment and setup described by the CI job, no Test Optimization events reached the mock intake.'
  const probeSummary = getInitializationProbeSummary(evidence.initializationProbe, framework)

  if (basicResult?.status === 'pass') {
    return `${summary} The same selected test command reported test data when the validator supplied the ` +
      'required Datadog initialization directly, so this repository can report when dd-trace is initialized ' +
      `correctly.${probeSummary}`
  }

  return `${summary}${probeSummary}`
}

function getCiWiringTestsRanRecommendation ({ basicResult, evidence }) {
  const probeReachedTestRunner = evidence.initializationProbe?.ran === true &&
    evidence.initializationProbe.reachedTestRunnerProcess === true
  const recommendation = probeReachedTestRunner
    ? 'Verify that the CI workflow actually sets NODE_OPTIONS with dd-trace/ci/init and the required Datadog ' +
      'environment variables. The NODE_OPTIONS probe reached the test runner for this command shape, so focus ' +
      'on missing or incomplete CI Datadog configuration before wrapper propagation.'
    : 'Verify that the CI workflow sets NODE_OPTIONS with dd-trace/ci/init for the final test runner, and that ' +
      'any package manager, monorepo runner, or wrapper preserves it.'

  if (basicResult?.status === 'pass') {
    return `${recommendation} Compare the passing direct-initialization command with the CI job command to find ` +
      'where the Datadog setup differs.'
  }

  return recommendation
}

function summarizeBasicReportingResult (basicResult) {
  if (!basicResult) {
    return {
      ran: false,
      reason: 'Basic Reporting was not run before CI wiring.',
    }
  }

  return {
    ran: true,
    status: basicResult.status,
    diagnosis: basicResult.diagnosis,
  }
}

function getInitializationProbeSummary (probe, framework) {
  if (!probe || probe.ran !== true) return ''

  const frameworkName = getDisplayFrameworkName(framework.framework)
  if (!probe.reachedAnyNodeProcess) {
    return ' The initialization probe did not reach any Node.js process in the CI command.'
  }

  if (probe.reachedTestRunnerProcess) {
    return ` The NODE_OPTIONS probe reached a ${frameworkName} process, so NODE_OPTIONS can reach the test ` +
      'runner in this command shape; inspect whether the CI workflow actually configures the required Datadog ' +
      'initialization and environment.'
  }

  const wrappers = formatToolNames([...probe.wrapperSignals, ...probe.packageManagerSignals])
  if (wrappers) {
    return ` The NODE_OPTIONS probe reached ${wrappers}, but it did not appear to reach a ${frameworkName} ` +
      'process. This usually means a package manager, monorepo runner, or wrapper removes NODE_OPTIONS before ' +
      'the tests start.'
  }

  return ` The NODE_OPTIONS probe reached a Node.js process, but it did not appear to reach a ${frameworkName} ` +
    'process.'
}

function getMonorepoFindings ({ framework, command, probe }) {
  const findings = []
  const commandText = [
    command.description,
    command.usesShell ? command.shellCommand : command.argv?.join(' '),
    framework.ciWiring?.diagnosis,
    ...(framework.ciWiring?.runnerToolChain || []),
    ...(framework.ciWiring?.toolChain || []),
    ...(framework.ciWiring?.commandChain || []),
  ].filter(Boolean).join('\n')

  if (/\bnx\b/i.test(commandText) || hasProbeTool(probe, 'nx')) {
    findings.push({
      id: 'nx-executor-env-forwarding',
      tool: 'nx',
      reason: 'Nx executors and wrapper scripts can sit between the CI command and the final test runner.',
      recommendation: 'Verify that NODE_OPTIONS and Datadog environment variables are preserved by every Nx ' +
        'target, executor, and wrapper that spawns the test runner.',
    })
  }

  if (/\bturbo(?:repo)?\b/i.test(commandText) || hasProbeTool(probe, 'turbo')) {
    findings.push({
      id: 'turbo-env-pass-through',
      tool: 'turbo',
      reason: 'Turborepo can filter environment variables for tasks.',
      recommendation: 'Verify turbo.json pass-through settings preserve NODE_OPTIONS and required DD_* variables ' +
        'for test tasks.',
    })
  }

  if (/\blage\b/i.test(commandText) || hasProbeTool(probe, 'lage')) {
    findings.push({
      id: 'lage-env-forwarding',
      tool: 'lage',
      reason: 'Lage can run package scripts through an intermediate task process.',
      recommendation: 'Verify the Lage task and any package script it invokes preserve NODE_OPTIONS and required ' +
        'DD_* variables for the final test runner.',
    })
  }

  if (probe?.reachedAnyNodeProcess && !probe.reachedTestRunnerProcess) {
    findings.push({
      id: 'node-options-not-observed-in-test-runner',
      tool: 'node',
      reason: 'The NODE_OPTIONS probe reached an intermediate Node.js process but not the detected test runner.',
      recommendation: 'Trace the command chain from the CI step to the test runner and find where NODE_OPTIONS is ' +
        'removed or replaced.',
    })
  }

  return findings
}

function hasProbeTool (probe, name) {
  const signals = [
    ...(probe?.wrapperSignals || []),
    ...(probe?.packageManagerSignals || []),
    ...(probe?.testRunnerSignals || []),
  ]
  return signals.some(signal => signal.name === name)
}

function formatToolNames (signals) {
  const names = []
  const seen = new Set()

  for (const signal of signals) {
    if (!signal.name || seen.has(signal.name)) continue
    seen.add(signal.name)
    names.push(signal.name)
  }

  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function getDisplayFrameworkName (frameworkName) {
  return {
    cucumber: 'Cucumber',
    cypress: 'Cypress',
    jest: 'Jest',
    mocha: 'Mocha',
    playwright: 'Playwright',
    vitest: 'Vitest',
  }[frameworkName] || frameworkName || 'test runner'
}

function commandOutputShowsTestsRan (lines) {
  return lines.some(line => {
    return /\b\d+\s+(?:passing|passed|failing|failed)\b/i.test(line) ||
      /\btests?\b.*\b(?:passed|failed)\b/i.test(line) ||
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
