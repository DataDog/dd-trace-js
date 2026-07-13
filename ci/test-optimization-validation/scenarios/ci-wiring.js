'use strict'

const fs = require('fs')
const path = require('path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiRemediation } = require('../ci-remediation')
const { buildCiWiringEnv, runCommand, serializeCommand } = require('../command-runner')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { runInitializationProbe } = require('../init-probe')
const { findLateInitialization } = require('../late-initialization')
const { normalizeRequests } = require('../payload-normalizer')
const { sanitizeForReport } = require('../redaction')
const { ensureSafeDirectory, writeFileSafely } = require('../safe-files')
const { getMissingEventDiagnosis, summarizeTestOutput } = require('./basic-reporting')
const {
  basicEventEvidence,
  error,
  fail,
  findInterestingLines,
  frameworkOutDir,
  hasAllBasicEventTypes,
  incomplete,
  pass,
  skip,
  tailInterestingLines,
} = require('./helpers')

async function runCiWiring ({ manifest, framework, intake, out, options, basicResult }) {
  const scenarioName = 'ci-wiring'

  try {
    const command = getCiWiringCommand(framework)
    if (!command) return getMissingCiWiringCommandResult(framework, manifest, basicResult)

    const outDir = frameworkOutDir(out, framework, scenarioName)
    ensureSafeDirectory(out, outDir, 'CI wiring artifact directory')
    intake.configure()
    intake.resetRequests()
    const baseEvidence = getCiWiringBaseEvidence({ framework, manifest, basicResult, command })
    const conclusiveStaticResult = await maybeConcludeMissingCiInitialization({
      baseEvidence,
      basicResult,
      command,
      framework,
      intake,
      options,
      out,
      outDir,
    })
    if (conclusiveStaticResult) return conclusiveStaticResult

    const result = await runCommand(command, {
      artifactRoot: out,
      env: buildCiWiringEnv({ intake }),
      envMode: 'clean',
      outDir,
      label: `${framework.id}:${scenarioName}`,
      repositoryRoot: options.repositoryRoot,
      verbose: options.verbose,
    })

    await wait(1000)
    const events = normalizeRequests(intake.requests)
    const sanitizedEvents = sanitizeForReport(events)
    writeFileSafely(
      out,
      path.join(outDir, 'events.ndjson'),
      sanitizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n',
      'CI wiring events artifact'
    )
    writeFileSafely(
      out,
      path.join(outDir, 'result.json'),
      `${JSON.stringify(sanitizeForReport(result), null, 2)}\n`,
      'CI wiring result artifact'
    )

    const ciWiringPreflight = getComparableCiWiringPreflight(framework, command)
    const evidence = {
      ...baseEvidence,
      commandExitCode: result.exitCode,
      commandTimedOut: result.timedOut,
      commandDescription: command.description,
      commandOutputSummary: summarizeTestOutput(result.stdout, result.stderr),
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

function getCiWiringBaseEvidence ({ framework, manifest, basicResult, command }) {
  return {
    commandDescription: command.description,
    ciCommandCandidate: buildCiCommandCandidate(framework),
    ciWiring: framework.ciWiring,
    ciConfigurationDiagnosis: framework.ciWiring?.diagnosis || framework.ciWiring?.reason,
    ciRemediation: buildCiRemediation(framework),
    nodeOptionsRemoval: findNodeOptionsRemoval(framework, manifest),
    existingDatadogInitScripts: findDatadogInitScripts(manifest, framework),
    lateInitialization: findLateInitialization(manifest, framework),
    forcedLocalBasicReporting: summarizeBasicReportingResult(basicResult),
  }
}

async function maybeConcludeMissingCiInitialization ({
  baseEvidence,
  basicResult,
  command,
  framework,
  intake,
  options,
  out,
  outDir,
}) {
  const initialization = framework.ciWiring?.initialization
  if (initialization?.status !== 'not_configured' || basicResult?.status !== 'pass') return

  let probe
  try {
    probe = await runInitializationProbe({ command, framework, intake, options, outDir })
  } catch (error) {
    baseEvidence.shortcutProbe = {
      ran: false,
      error: error?.message || String(error),
    }
    return
  } finally {
    intake.resetRequests()
  }
  if (probe.summary?.reachedTestRunnerProcess !== true) {
    baseEvidence.shortcutProbe = probe.summary
    return
  }

  const frameworkName = getDisplayFrameworkName(framework.framework)
  const staticEvidence = initialization.evidence.join(' ')
  const diagnosis = `The selected CI configuration does not initialize Datadog. ${staticEvidence} ` +
    `A short NODE_OPTIONS probe reached the ${frameworkName} process, so the CI command can carry the required ` +
    'initialization to the test runner. Basic Reporting already proved this test suite reports when Datadog is ' +
    'initialized, so the validator did not replay the full CI test suite.'
  const evidence = {
    ...baseEvidence,
    initializationProbe: probe.summary,
    ciCommandExecution: {
      mode: 'initialization-probe-only',
      fullReplayRan: false,
      reason: 'Static CI evidence showed no Datadog initialization and the exact-command probe reached the ' +
        'selected test runner.',
    },
    monorepoFindings: getMonorepoFindings({ framework, command, probe: probe.summary }),
    eventLevelFailure: {
      kind: 'ci-wiring-static-missing-initialization',
      missingLevels: ['session', 'module', 'suite', 'test'],
      summary: diagnosis,
      recommendation: baseEvidence.ciRemediation.summary,
    },
    ...basicEventEvidence([]),
  }
  const resultPath = path.join(outDir, 'result.json')
  writeFileSafely(
    out,
    resultPath,
    `${JSON.stringify(sanitizeForReport({ status: 'fail', diagnosis, evidence }), null, 2)}\n`,
    'CI wiring static conclusion artifact'
  )
  return fail(framework, 'ci-wiring', diagnosis, evidence, null, {
    ...probe.artifacts,
    result: resultPath,
  })
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

  const replayCommand = getShellReplayCommand(command, framework.ciWiring.shell)
  if (replayCommand) return replayCommand

  const shell = getReplayShell(framework.ciWiring.shell)
  if (!shell) return command

  return {
    ...command,
    shell,
  }
}

/**
 * Translates a CI shell with flags into a local argv command.
 *
 * @param {object} command shell command from the manifest
 * @param {string} shell recorded CI shell
 * @returns {object|undefined} argv command preserving the recorded shell flags
 */
function getShellReplayCommand (command, shell) {
  const tokens = tokenizeShellTemplate(shell)
  const hasTemplate = tokens.includes('{0}')
  if (tokens.length <= 1 && !hasTemplate) return

  const argv = hasTemplate ? tokens.filter(token => token !== '{0}') : tokens
  const executable = argv[0]
  if (!isBourneShell(executable)) return

  return {
    ...command,
    argv: [...argv, '-c', command.shellCommand],
    shell: undefined,
    shellCommand: undefined,
    usesShell: false,
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

/**
 * Splits a CI shell template into tokens for common unquoted shell templates.
 *
 * @param {string} shell recorded CI shell template
 * @returns {string[]} shell template tokens
 */
function tokenizeShellTemplate (shell) {
  return String(shell || '').trim().split(/\s+/).filter(Boolean)
}

/**
 * Checks whether a shell executable accepts POSIX -c command replay.
 *
 * @param {string|undefined} executable shell executable
 * @returns {boolean} true for Bourne-style shells
 */
function isBourneShell (executable) {
  const basename = path.basename(String(executable || ''))
  return basename === 'bash' || basename === 'sh' || basename === 'zsh'
}

async function maybeRunInitializationProbe ({ command, framework, intake, options, outDir, result, evidence }) {
  if (result.timedOut === true) return {}
  if (!commandOutputShowsTestsRan(evidence.commandOutputSummary)) return {}
  if (evidence.nodeOptionsRemoval) {
    return {
      summary: {
        ran: false,
        skippedBecauseConfigurationProvesRemoval: true,
        reason: `The package script expansion ${evidence.nodeOptionsRemoval.command} explicitly removes ` +
          'NODE_OPTIONS before the test runner starts.',
      },
    }
  }

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

function getMissingCiWiringCommandResult (framework, manifest, basicResult) {
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
  const diagnosis = ciWiring?.diagnosis ||
    ciWiring?.reason ||
    'No replayable CI wiring command was provided in the manifest.'
  const ciRemediation = buildCiRemediation(framework)
  const evidence = {
    ciCommandCandidate: buildCiCommandCandidate(framework),
    ciWiring,
    ciRemediation,
    recommendation: 'Add ciWiringCommand to the manifest when a CI test step can be safely replayed locally.',
  }

  if (ciWiring?.initialization?.status === 'not_configured' && basicResult?.status === 'pass') {
    const staticEvidence = ciWiring.initialization.evidence.join(' ')
    const summary = `The selected CI configuration does not initialize Datadog. ${staticEvidence} ` +
      'Basic Reporting proved this test suite reports when Datadog is initialized. The exact CI command could not ' +
      `be replayed locally: ${diagnosis} This does not change the current conclusion because CI provides no ` +
      'initialization to propagate. Apply the generated CI configuration below; the next normal CI test run will ' +
      'provide end-to-end verification.'
    evidence.forcedLocalBasicReporting = summarizeBasicReportingResult(basicResult)
    evidence.eventLevelFailure = {
      kind: 'ci-wiring-static-missing-initialization',
      missingLevels: ['session', 'module', 'suite', 'test'],
      summary,
      recommendation: ciRemediation.summary,
    }
    evidence.recommendation = ciRemediation.summary
    return fail(framework, 'ci-wiring', summary, evidence)
  }

  if (ciWiring?.status === 'skip') return skip(framework, 'ci-wiring', diagnosis, evidence)
  if (ciWiring?.status === 'pass' || ciWiring?.status === 'fail') {
    return fail(framework, 'ci-wiring', diagnosis, evidence)
  }
  return incomplete(
    framework,
    'ci-wiring',
    `The validation manifest is incomplete: ${diagnosis}`,
    evidence
  )
}

function getCiWiringEventFailure ({ framework, result, evidence, basicResult }) {
  const localFailure = getMissingEventDiagnosis({ framework, result, evidence })
  const testsRan = commandOutputShowsTestsRan(evidence.commandOutputSummary)

  if (testsRan) {
    return {
      ...localFailure,
      kind: 'ci-wiring-no-test-optimization-events',
      summary: getCiWiringTestsRanSummary({ basicResult, evidence, framework }),
      recommendation: getCiWiringTestsRanRecommendation({ basicResult, evidence, framework }),
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
  if (evidence.nodeOptionsRemoval) {
    return getNodeOptionsRemovalDiagnosis({ basicResult, evidence, framework })
  }

  const summary = 'The test command used by the CI job was identified and ran tests. When it ran with only the ' +
    'environment and setup described by the CI job, no Test Optimization events reached the mock intake.'
  const configurationSummary = evidence.ciConfigurationDiagnosis
    ? ` Manifest CI discovery recorded: ${evidence.ciConfigurationDiagnosis}`
    : ''
  const probeSummary = getInitializationProbeSummary(evidence.initializationProbe, framework)
  const lateInitializationSummary = getLateInitializationSummary(evidence.lateInitialization)

  if (basicResult?.status === 'pass') {
    return `${summary}${configurationSummary}${lateInitializationSummary} ` +
      'The same selected test command ' +
      'reported test data when the ' +
      'validator supplied the ' +
      'required Datadog initialization directly, so this repository can report when dd-trace is initialized ' +
      `correctly.${probeSummary}`
  }

  return `${summary}${configurationSummary}${lateInitializationSummary}${probeSummary}`
}

function getCiWiringTestsRanRecommendation ({ basicResult, evidence, framework }) {
  const existingInitScripts = evidence.existingDatadogInitScripts || []
  const lateInitialization = evidence.lateInitialization || []
  const probeReachedTestRunner = evidence.initializationProbe?.ran === true &&
    evidence.initializationProbe.reachedTestRunnerProcess === true
  const nodeOptionsRemoval = evidence.nodeOptionsRemoval
  let recommendation

  if (nodeOptionsRemoval) {
    const source = nodeOptionsRemoval.scriptName && nodeOptionsRemoval.packageJson
      ? `Script \`${nodeOptionsRemoval.scriptName}\` in \`${nodeOptionsRemoval.packageJson}\``
      : 'The package script'
    recommendation = `${source} clears NODE_OPTIONS before the test runner starts. Remove the empty ` +
      '`NODE_OPTIONS=` assignment, or pass the CI-provided `-r dd-trace/ci/init` preload to the next command.'
  } else if (lateInitialization.length > 0) {
    const setupFiles = lateInitialization.map(finding => `\`${finding.setupFile}\``).join(', ')
    recommendation = `Move Test Optimization initialization out of Vitest setup file ${setupFiles}. ` +
      'Vitest setup files run after the test runner starts, which is too late for dd-trace to instrument the ' +
      'runner. Set `NODE_OPTIONS=-r dd-trace/ci/init` on the CI test command instead.'
  } else if (existingInitScripts.length > 0) {
    const scriptNames = existingInitScripts.map(script => `\`${script.name}\``).join(', ')
    recommendation = `The package already defines ${scriptNames} with the required ` +
      '`dd-trace/ci/init` preload. Update the identified CI test step to invoke that script, or copy its ' +
      '`NODE_OPTIONS` initialization into the CI test command.'
  } else if (probeReachedTestRunner) {
    recommendation = `${evidence.ciRemediation?.summary || buildCiRemediation(framework).summary} ` +
      'The NODE_OPTIONS probe reached the test runner for this command shape, so no package-manager or wrapper ' +
      'change is needed.'
  } else {
    recommendation = 'Verify that the CI workflow sets NODE_OPTIONS with dd-trace/ci/init for the final test ' +
      'runner, and that any package manager, monorepo runner, or wrapper preserves it.'
  }

  if (basicResult?.status === 'pass' && !nodeOptionsRemoval && lateInitialization.length === 0 &&
    !probeReachedTestRunner) {
    return `${recommendation} Compare the passing direct-initialization command with the CI job command to find ` +
      'where the Datadog setup differs.'
  }

  return recommendation
}

function getNodeOptionsRemovalDiagnosis ({ basicResult, evidence, framework }) {
  const finding = evidence.nodeOptionsRemoval
  const frameworkName = getDisplayFrameworkName(framework.framework)
  const ciCommand = evidence.ciCommandCandidate?.command
    ? `When CI runs \`${evidence.ciCommandCandidate.command}\`, `
    : 'In the selected CI test job, '
  const source = finding.scriptName && finding.packageJson
    ? `script \`${finding.scriptName}\` in \`${finding.packageJson}\``
    : 'a package script'
  const directResult = basicResult?.status === 'pass'
    ? ` When the same ${frameworkName} test command runs with ` +
      '`NODE_OPTIONS=-r dd-trace/ci/init` supplied directly, it reports test data successfully.'
    : ''

  return `The CI test command ran tests, but no Test Optimization events reached the mock intake. ${ciCommand}` +
    `${source} expands to \`${finding.command}\`. The empty \`NODE_OPTIONS=\` assignment clears the Datadog ` +
    `preload before ${frameworkName} starts.${directResult}`
}

function findNodeOptionsRemoval (framework, manifest) {
  const commands = framework.ciWiring?.packageScriptExpansionChain || []
  for (const command of commands) {
    if (typeof command !== 'string') continue
    if (/(?:^|\s)NODE_OPTIONS\s*=\s*(?=\s|$)/.test(command) ||
      /(?:^|\s)unset\s+NODE_OPTIONS(?:\s|$)/.test(command) ||
      /(?:^|\s)env\s+-u\s+NODE_OPTIONS(?:\s|$)/.test(command)) {
      return {
        command,
        ...findPackageScriptSource(manifest, framework, command),
      }
    }
  }
}

function findPackageScriptSource (manifest, framework, command) {
  const roots = new Set([manifest?.repository?.root, framework.project?.root].filter(Boolean))
  for (const root of roots) {
    const packageJsonPath = path.join(root, 'package.json')
    let packageJson
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    } catch {
      continue
    }

    for (const [scriptName, scriptCommand] of Object.entries(packageJson.scripts || {})) {
      if (scriptCommand === command) return { packageJson: packageJsonPath, scriptName }
    }
  }
  return {}
}

function getLateInitializationSummary (findings) {
  if (!Array.isArray(findings) || findings.length === 0) return ''
  const setupFiles = findings.map(finding => `\`${finding.setupFile}\``).join(', ')
  return ' Static configuration inspection found Test Optimization initialization in Vitest setup file ' +
    `${setupFiles}. Vitest loads setup files after the runner starts, so this initialization is too late to ` +
    'instrument the test runner.'
}

/**
 * Finds package scripts that already set the required Test Optimization preload.
 *
 * @param {object|undefined} manifest normalized validation manifest
 * @param {object} framework manifest framework entry
 * @returns {{name: string, packageJson: string}[]} matching package scripts
 */
function findDatadogInitScripts (manifest, framework) {
  const roots = new Set([framework.project?.root, manifest?.repository?.root].filter(Boolean))
  const scripts = []

  for (const root of roots) {
    let packageJson
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    } catch {
      continue
    }

    for (const [name, command] of Object.entries(packageJson.scripts || {})) {
      if (typeof command !== 'string' || !/\bNODE_OPTIONS\s*=.*\bdd-trace\/ci\/init\b/.test(command)) {
        continue
      }
      scripts.push({
        name,
        packageJson: path.join(root, 'package.json'),
      })
    }
  }

  return scripts
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

  if (probe?.reachedAnyNodeProcess && !probe.reachedTestRunnerProcess && !findNodeOptionsRemoval(framework)) {
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
  getCiWiringCommand,
  runCiWiring,
}
