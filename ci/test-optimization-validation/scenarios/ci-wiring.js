'use strict'

const fs = require('fs')
const path = require('path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiWiringEnv, runCommand, serializeCommand } = require('../command-runner')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { runInitializationProbe } = require('../init-probe')
const { normalizeRequests } = require('../payload-normalizer')
const { sanitizeForReport } = require('../redaction')
const { getMissingEventDiagnosis, summarizeTestOutput } = require('./basic-reporting')
const {
  basicEventEvidence,
  error,
  fail,
  findInterestingLines,
  frameworkOutDir,
  hasAllBasicEventTypes,
  pass,
  skip,
  tailInterestingLines,
} = require('./helpers')

async function runCiWiring ({ manifest, framework, intake, out, options, basicResult }) {
  const scenarioName = 'ci-wiring'

  try {
    const command = getCiWiringCommand(framework)
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

    const ciWiringPreflight = getComparableCiWiringPreflight(framework, command)
    const evidence = {
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: command.description,
      commandOutputSummary: summarizeTestOutput(result.stdout, result.stderr),
      ciCommandCandidate: buildCiCommandCandidate(framework),
      ciWiring: framework.ciWiring,
      forcedLocalBasicReporting: summarizeBasicReportingResult(basicResult),
      preflight: summarizePreflight(ciWiringPreflight),
      ...basicEventEvidence(events),
    }

    if (!hasAllBasicEventTypes(events)) {
      const commandFailure = summarizeCiCommandFailure(result, evidence)
      if (commandFailure.kind !== 'ci-wiring-command-result-unknown') {
        evidence.commandFailure = commandFailure
      }
      evidence.debugSignals = summarizeCiDebugSignals(result)
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

    if (matchesPreflightExitCode(ciWiringPreflight, result.exitCode)) {
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

/**
 * Returns the CI wiring command with the replay shell recorded by CI discovery when available.
 *
 * @param {object} framework manifest framework entry
 * @returns {object|undefined} command to run
 */
function getCiWiringCommand (framework) {
  const command = framework.ciWiringCommand
  if (!command || !command.usesShell || command.shell || !framework.ciWiring?.shell) return command

  const shell = getReplayShell(framework.ciWiring.shell)
  if (!shell) return command

  return {
    ...command,
    shell,
  }
}

/**
 * Resolves a CI shell description to a local shell executable.
 *
 * @param {string} shell recorded CI shell
 * @returns {string|undefined} local shell executable
 */
function getReplayShell (shell) {
  const value = String(shell || '').trim()
  if (!value) return

  const firstToken = value.split(/\s+/)[0]
  if (firstToken && value.includes('{0}')) return firstToken
  if (!/\s/.test(value)) return value
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

  const commandFailure = evidence.commandFailure || summarizeCiCommandFailure(result, evidence)
  if (commandFailure.kind !== 'ci-wiring-command-result-unknown') {
    return {
      ...localFailure,
      kind: commandFailure.kind,
      missingLevels: localFailure.missingLevels,
      signals: commandFailure.signals,
      summary: commandFailure.summary,
      recommendation: commandFailure.recommendation,
    }
  }

  return {
    ...localFailure,
    summary: 'The CI-shaped command did not emit Test Optimization events, and the validator could not determine ' +
      'from its output whether tests ran. Review the recorded stdout/stderr artifacts for the selected CI step.',
    recommendation: 'Verify the selected CI step is the real test step, then rerun after making the command output ' +
      'or preflight evidence identify the test runner result.',
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

function summarizeCiCommandFailure (result, evidence) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const testsRan = commandOutputShowsTestsRan(evidence.commandOutputSummary || [])
  const common = {
    exitCode: result.exitCode,
    stderrExcerpt: tailInterestingLines(result.stderr),
    stdoutExcerpt: tailInterestingLines(result.stdout),
  }

  if (testsRan) {
    return {
      ...common,
      kind: 'ci-wiring-command-result-unknown',
      signals: [],
      summary: 'The CI-shaped command ran tests; missing Test Optimization events are reported separately.',
      recommendation: 'Review CI wiring event failure evidence.',
    }
  }

  const preloadFailure = detectDatadogPreloadResolutionFailure(output)
  if (preloadFailure) {
    return {
      ...common,
      kind: 'ci-wiring-preload-resolution-failed',
      signals: preloadFailure.signals,
      summary: 'The CI-shaped command failed before tests started because Node could not resolve the Test ' +
        'Optimization preload `dd-trace/ci/init` from the command working directory.',
      recommendation: 'Make sure `dd-trace` is installed where the CI command starts, or run the CI command from ' +
        'the package working directory that can resolve `dd-trace/ci/init`. After the preload resolves, rerun CI ' +
        'wiring validation to check whether the required Datadog setup reaches the final test runner.',
    }
  }

  if (result.timedOut === true) {
    return {
      ...common,
      kind: 'ci-wiring-command-timed-out',
      signals: [],
      summary: 'The CI-shaped command timed out before the validator could observe Test Optimization events.',
      recommendation: 'Choose a smaller representative CI test command or record the setup needed to make the ' +
        'selected command complete within the validation timeout.',
    }
  }

  if (result.exitCode !== 0 && !testsRan) {
    const termination = Number.isInteger(result.exitCode) ? `exited ${result.exitCode}` : 'failed'
    const buildErrors = findInterestingLines(output, [
      /Cannot find module/,
      /Module not found/,
      /Error \[ERR_MODULE_NOT_FOUND\]/,
      /Could not resolve /,
      /command not found/,
      /No test files found/,
    ])

    return {
      ...common,
      buildErrors,
      kind: 'ci-wiring-command-failed-before-tests',
      signals: buildErrors,
      summary: `The CI-shaped command ${termination} before the validator observed any tests running. ` +
        'No CI wiring conclusion about Test Optimization initialization was reached for this command.',
      recommendation: 'Fix or document the command/setup failure first. CI wiring can only be interpreted after ' +
        'the selected CI-shaped command reaches the test runner.',
    }
  }

  if (result.exitCode === 0 && !testsRan) {
    return {
      ...common,
      kind: 'ci-wiring-no-observed-tests',
      signals: [],
      summary: 'The CI-shaped command exited 0, but the validator did not observe test-runner output or Test ' +
        'Optimization events.',
      recommendation: 'Verify that the selected CI step actually runs tests. If it is a wrapper with unusual ' +
        'output, record preflight observedTestCount or choose a representative command whose output identifies ' +
        'the test result.',
    }
  }

  return {
    ...common,
    kind: 'ci-wiring-command-result-unknown',
    signals: [],
    summary: 'The CI-shaped command result did not explain why Test Optimization events were missing.',
    recommendation: 'Review stdout, stderr, and debug lines for the selected CI-shaped command.',
  }
}

function getComparableCiWiringPreflight (framework, command) {
  if (framework.ciWiringPreflight?.ran === true) {
    return {
      ...framework.ciWiringPreflight,
      source: 'ciWiringPreflight',
    }
  }

  if (commandsHaveSameExecutionShape(command, framework.existingTestCommand)) {
    return {
      ...framework.preflight,
      source: 'existingTestCommand',
    }
  }

  return {
    ran: false,
    reason: 'No dd-trace-less preflight result was recorded for the selected CI wiring command shape.',
  }
}

function commandsHaveSameExecutionShape (left, right) {
  if (!left || !right) return false
  if (left.cwd !== right.cwd) return false
  if (Boolean(left.usesShell) !== Boolean(right.usesShell)) return false
  return serializeCommand(left) === serializeCommand(right)
}

function detectDatadogPreloadResolutionFailure (output) {
  if (!/dd-trace(?:\/ci\/init)?/.test(output)) return null
  if (!/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(output)) return null

  const signals = findInterestingLines(output, [
    /Cannot find module ['"]dd-trace\/ci\/init['"]/,
    /Cannot find package ['"]dd-trace['"]/,
    /Error \[ERR_MODULE_NOT_FOUND\].*dd-trace\/ci\/init/,
    /MODULE_NOT_FOUND/,
    /internal\/preload/,
  ], 8)

  return { signals }
}

function summarizeCiDebugSignals (result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const lines = findInterestingLines(output, [
    /dd-trace/i,
    /datadog/i,
    /ci visibility/i,
    /test optimization/i,
    /ECONNREFUSED/,
    /ECONNRESET/,
    /ETIMEDOUT/,
    /socket hang up/,
    /failed to send/i,
    /writer/i,
  ], 12)

  return {
    debugEnvEnabled: true,
    lines,
  }
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
      /\bfailed:\s*[1-9]\d*\b/i.test(line) ||
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
      reason: preflight?.reason || 'No dd-trace-less preflight result was recorded in the manifest.',
    }
  }

  return {
    ran: true,
    source: preflight.source,
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
