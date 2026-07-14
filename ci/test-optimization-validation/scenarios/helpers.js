'use strict'

const fs = require('node:fs')
const path = require('path')

const { buildCiWiringEnv, buildDatadogEnv, runCommand } = require('../command-runner')
const {
  cleanupGeneratedRuntimeFiles,
  findGeneratedScenario,
  writeGeneratedFiles,
} = require('../generated-files')
const {
  eventsOfType,
  findTestsByIdentity,
} = require('../payload-normalizer')
const { getLocalValidationCommand } = require('../local-command')
const { cleanupOfflineFixture, createOfflineFixture } = require('../offline-fixtures')
const { parseOfflineSummary, readOfflineOutput } = require('../offline-output')
const { sanitizeForReport } = require('../redaction')
const { createFileSafely, writeFileSafely } = require('../safe-files')

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-?]*[ -/]*[@-~]`}`, 'g')

function frameworkOutDir (out, framework, scenario) {
  return path.join(out, 'runs', sanitize(framework.id), scenario)
}

function sanitize (value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

async function runInstrumentedCommand ({
  framework,
  out,
  scenarioName,
  command,
  options,
  extraEnv,
  fixtureConfig,
  ciWiring = false,
}) {
  const outDir = frameworkOutDir(out, framework, scenarioName)
  const rawOutputFile = path.join(outDir, '.offline-events.raw.ndjson')
  createFileSafely(out, rawOutputFile, '', 'offline validation event output')
  let fixture
  let result
  let offline
  try {
    fixture = createOfflineFixture({
      approvedPlanSha256: options.approvedPlanSha256,
      offlineFixtureNonce: options.offlineFixtureNonce,
      framework,
      repositoryRoot: options.repositoryRoot,
      scenarioName,
      ...fixtureConfig,
    })
    const validationEnv = ciWiring
      ? buildCiWiringEnv({ fixture, outputFile: rawOutputFile })
      : buildDatadogEnv({ fixture, outputFile: rawOutputFile, scenario: scenarioName, framework, command })
    result = await runCommand(command, {
      env: {
        ...validationEnv,
        ...extraEnv,
      },
      artifactRoot: out,
      envMode: 'clean',
      outDir,
      label: `${framework.id}:${scenarioName}`,
      repositoryRoot: options.repositoryRoot,
      verbose: options.verbose,
    })
    offline = readOfflineOutput(rawOutputFile)
    offline.summary = parseOfflineSummary(result.stderr)
    if (offline.summary?.errors.length > 0) {
      throw new Error(`Offline Test Optimization exporter failed: ${offline.summary.errors.join(', ')}`)
    }
    if (offline.summary &&
      (offline.summary.records !== offline.recordCount || offline.summary.events !== offline.events.length)) {
      throw new Error('Offline Test Optimization exporter summary does not match the event artifact.')
    }
  } finally {
    if (fixture) cleanupOfflineFixture(fixture.root)
    fs.rmSync(rawOutputFile, { force: true })
  }

  const events = offline.events
  const sanitizedEvents = sanitizeForReport(events)
  writeFileSafely(
    out,
    path.join(outDir, 'events.ndjson'),
    sanitizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n',
    'scenario events artifact'
  )
  writeFileSafely(
    out,
    path.join(outDir, 'result.json'),
    `${JSON.stringify(sanitizeForReport(result), null, 2)}\n`,
    'scenario result artifact'
  )

  return { result, events, offline, outDir }
}

async function failWithDebugRerun ({
  command,
  fixtureConfig,
  diagnosis,
  evidence,
  framework,
  options,
  out,
  outDir,
  scenarioName,
  skipDebug,
}) {
  if (!skipDebug && command) {
    const debugRerun = await runDebugInstrumentedCommand({
      command,
      fixtureConfig,
      framework,
      options,
      out,
      scenarioName,
    })
    evidence.debugRerun = debugRerun.summary

    const failure = fail(framework, scenarioName, diagnosis, evidence, outDir)
    if (debugRerun.artifacts) {
      failure.artifacts.push(...debugRerun.artifacts)
    }
    return failure
  }

  return fail(framework, scenarioName, diagnosis, evidence, outDir)
}

async function runDebugInstrumentedCommand ({
  command,
  fixtureConfig,
  framework,
  options,
  out,
  scenarioName,
}) {
  try {
    cleanupGeneratedRuntimeFiles(framework)

    const debug = await runInstrumentedCommand({
      framework,
      out,
      scenarioName: `${scenarioName}-debug`,
      command,
      options,
      fixtureConfig,
      extraEnv: {
        DD_TRACE_DEBUG: '1',
        DD_TRACE_LOG_LEVEL: 'debug',
      },
    })

    return {
      summary: summarizeDebugRerun(debug),
      artifacts: getDebugArtifacts(debug.outDir),
    }
  } catch (err) {
    return {
      summary: {
        ran: false,
        error: err && err.message ? err.message : String(err),
      },
    }
  }
}

async function prepareGeneratedScenario (framework, scenarioId) {
  const scenario = findGeneratedScenario(framework, scenarioId)
  if (!scenario) return { scenario: null, written: [] }
  cleanupGeneratedRuntimeFiles(framework)
  const written = await writeGeneratedFiles(framework)
  return {
    scenario: {
      ...scenario,
      runCommand: getLocalValidationCommand(framework, scenario.runCommand),
    },
    written,
  }
}

function requireGeneratedScenario (framework, scenarioId, scenarioName) {
  const strategy = framework.generatedTestStrategy
  if (strategy?.status === 'not_possible') {
    return skip(
      framework,
      scenarioName,
      `Skipped because this advanced feature is not eligible: ${strategy.reason}`,
      getGeneratedStrategySkipEvidence(framework, scenarioName, scenarioId)
    )
  }

  if (!strategy || strategy.status !== 'verified') {
    return incomplete(
      framework,
      scenarioName,
      'The validation manifest is incomplete because no verified generated test strategy is available. ' +
        'No conclusion was reached for this advanced feature.',
      getGeneratedStrategySkipEvidence(framework, scenarioName, scenarioId)
    )
  }

  const scenario = findGeneratedScenario(framework, scenarioId)
  if (!scenario) {
    return incomplete(
      framework,
      scenarioName,
      `The validation manifest is incomplete because generated scenario "${scenarioId}" is missing. ` +
        'No conclusion was reached for this advanced feature.',
      {
        featureEligibility: {
          eligible: false,
          blockedBy: 'generated-scenario',
          reasonCode: 'generated-scenario-missing',
          scenario: scenarioName,
          requiredGeneratedScenario: scenarioId,
        },
      }
    )
  }

  return null
}

/**
 * Builds stable evidence for advanced feature checks that cannot run without generated tests.
 *
 * @param {object} framework manifest framework entry
 * @param {string} scenarioName advanced scenario name
 * @param {string} scenarioId required generated scenario id
 * @returns {object} skip evidence for reports and UI payloads
 */
function getGeneratedStrategySkipEvidence (framework, scenarioName, scenarioId) {
  const strategy = framework.generatedTestStrategy
  const status = strategy?.status || 'missing'
  let reasonCode = 'generated-test-strategy-missing'

  if (status === 'proposed') {
    reasonCode = 'generated-test-strategy-proposed-only'
  } else if (status === 'not_possible') {
    reasonCode = 'generated-test-strategy-not-possible'
  } else if (status !== 'missing') {
    reasonCode = 'generated-test-strategy-not-verified'
  }

  return {
    featureEligibility: {
      eligible: false,
      blockedBy: 'generated-test-strategy',
      reason: strategy?.reason,
      reasonCode,
      scenario: scenarioName,
      strategyStatus: status,
      requiredGeneratedScenario: scenarioId,
    },
  }
}

function basicEventEvidence (events) {
  return {
    testSessionEvents: eventsOfType(events, 'test_session_end').length,
    testModuleEvents: eventsOfType(events, 'test_module_end').length,
    testSuiteEvents: eventsOfType(events, 'test_suite_end').length,
    testEvents: eventsOfType(events, 'test').length,
    samples: basicEventSamples(events),
  }
}

function hasAllBasicEventTypes (events) {
  const evidence = basicEventEvidence(events)
  return evidence.testSessionEvents > 0 &&
    evidence.testModuleEvents > 0 &&
    evidence.testSuiteEvents > 0 &&
    evidence.testEvents > 0
}

function testsForScenario (events, scenario) {
  return findTestsByIdentity(events, scenario.testIdentities || [])
}

async function discoverScenarioTests ({ framework, out, scenarioName, scenario, options }) {
  const baseline = await runInstrumentedCommand({
    framework,
    out,
    scenarioName: `${scenarioName}-baseline`,
    command: scenario.runCommand,
    options,
  })
  let tests = testsForScenario(baseline.events, scenario)
  let identityMatch = 'manifest'
  if (tests.length === 0) {
    const nameAndFileIdentities = (scenario.testIdentities || [])
      .filter(identity => identity.name && identity.file)
    tests = findTestsByIdentity(baseline.events, nameAndFileIdentities, { ignoreSuite: true })
    if (tests.length > 0) identityMatch = 'name-and-file-fallback'
  }
  cleanupGeneratedRuntimeFiles(framework)
  return {
    ...baseline,
    identityMatch,
    tests,
    testIdentities: tests.map(testToIdentity),
  }
}

function testsForDiscoveredScenario (events, scenario, discovery) {
  if (discovery?.testIdentities?.length > 0) {
    return findTestsByIdentity(events, discovery.testIdentities)
  }
  return testsForScenario(events, scenario)
}

function discoveryEvidence (discovery) {
  return {
    baselineCommandExitCode: discovery.result.exitCode,
    baselineIdentityMatch: discovery.identityMatch,
    baselineMatchingTestEvents: discovery.tests.length,
    baselineSamples: testEventSamples(discovery.tests),
  }
}

function testToIdentity (test) {
  return {
    discovered: true,
    suite: test.testSuite,
    name: test.testName,
    file: test.testSourceFile,
    parameters: test.meta?.['test.parameters'],
  }
}

function basicEventSamples (events) {
  return [
    sampleLevel(events, 'test_session_end', 'test session'),
    sampleLevel(events, 'test_module_end', 'test module'),
    sampleLevel(events, 'test_suite_end', 'test suite'),
    sampleLevel(events, 'test', 'test'),
  ].filter(Boolean)
}

function sampleLevel (events, type, level) {
  const event = eventsOfType(events, type)[0]
  if (!event) return null

  const sample = { level }
  copy(sample, event.meta, 'test.command')
  copy(sample, event.meta, 'test.module')
  copy(sample, event.meta, 'test.suite')
  copy(sample, event.meta, 'test.name')
  copy(sample, event.meta, 'test.status')
  return sample
}

function testEventSamples (tests) {
  return tests.slice(0, 3).map(test => {
    const sample = {}
    copy(sample, test.meta, 'test.name')
    copy(sample, test.meta, 'test.status')
    copy(sample, test.meta, 'test.is_new')
    copy(sample, test.meta, 'test.is_retry')
    copy(sample, test.meta, 'test.retry_reason')
    copy(sample, test.meta, 'test.final_status')
    copy(sample, test.meta, 'test.test_management.enabled')
    copy(sample, test.meta, 'test.test_management.is_test_disabled')
    copy(sample, test.meta, 'test.test_management.is_quarantined')
    copy(sample, test.meta, 'test.test_management.is_attempt_to_fix')
    copy(sample, test.meta, 'test.test_management.attempt_to_fix_passed')
    return sample
  })
}

function copy (target, source, key) {
  if (source && source[key] !== undefined) target[key] = source[key]
}

function summarizeDebugRerun ({ result, events, outDir }) {
  const output = `${result.stdout}\n${result.stderr}`

  return {
    ran: true,
    commandExitCode: result.exitCode,
    commandTimedOut: result.timedOut,
    debugCommandFailed: result.exitCode !== 0 || result.timedOut === true,
    artifactDirectory: outDir,
    ...basicEventEvidence(events),
    debugLines: findInterestingLines(output, [
      /dd-trace/i,
      /test optimization/i,
      /ci visibility/i,
      /citestcycle/i,
      /auto.?test.?retr/i,
      /flaky.?retr/i,
      /\b(?:error|warn)\b/i,
    ], 20),
    stderrExcerpt: tailInterestingLines(result.stderr),
    stdoutExcerpt: tailInterestingLines(result.stdout),
  }
}

function getDebugArtifacts (outDir) {
  return [
    'command.json',
    'stdout.txt',
    'stderr.txt',
    'events.ndjson',
    'result.json',
  ].map(filename => `${outDir}/${filename}`)
}

function findInterestingLines (output, patterns, limit = 8) {
  return uniqueLines(output.split(/\r?\n/).map(stripAnsi).filter(line => {
    if (/^\s*Encoding payload:/.test(line)) return false
    return patterns.some(pattern => pattern.test(line))
  }).map(truncateLine)).slice(0, limit)
}

function truncateLine (line) {
  const maxLength = 500
  return line.length > maxLength ? `${line.slice(0, maxLength)}...` : line
}

function tailInterestingLines (output) {
  return uniqueLines(output
    .split(/\r?\n/)
    .map(stripAnsi)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
    .filter(line => !/^\s*Encoding payload:/.test(line))
    .map(truncateLine))
    .slice(-12)
}

function stripAnsi (line) {
  return line.replaceAll(ANSI_PATTERN, '')
}

function uniqueLines (lines) {
  const seen = new Set()
  const unique = []
  for (const line of lines) {
    const normalized = line.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(line)
  }
  return unique
}

function pass (framework, scenario, diagnosis, evidence, outDir, extraArtifacts) {
  return result(framework, scenario, 'pass', diagnosis, evidence, outDir, extraArtifacts)
}

function fail (framework, scenario, diagnosis, evidence, outDir, extraArtifacts) {
  return result(framework, scenario, 'fail', diagnosis, evidence, outDir, extraArtifacts)
}

function skip (framework, scenario, diagnosis, evidence = {}) {
  return result(framework, scenario, 'skip', diagnosis, evidence, null)
}

function incomplete (framework, scenario, diagnosis, evidence = {}) {
  return result(framework, scenario, 'error', diagnosis, {
    ...evidence,
    manifestIncomplete: true,
  }, null)
}

function error (framework, scenario, err, outDir) {
  return result(framework, scenario, 'error', err && err.stack ? err.stack : String(err), {}, outDir)
}

function result (framework, scenario, status, diagnosis, evidence, outDir, extraArtifacts) {
  const artifacts = outDir
    ? [
        path.join(outDir, 'command.json'),
        path.join(outDir, 'stdout.txt'),
        path.join(outDir, 'stderr.txt'),
        path.join(outDir, 'events.ndjson'),
        path.join(outDir, 'result.json'),
      ]
    : []

  if (Array.isArray(extraArtifacts)) {
    artifacts.push(...extraArtifacts)
  } else if (extraArtifacts && typeof extraArtifacts === 'object') {
    artifacts.push(...Object.values(extraArtifacts).filter(Boolean))
  }

  return {
    frameworkId: framework.id,
    scenario,
    status,
    diagnosis,
    evidence,
    artifacts,
  }
}

module.exports = {
  basicEventEvidence,
  discoverScenarioTests,
  discoveryEvidence,
  error,
  fail,
  failWithDebugRerun,
  findInterestingLines,
  frameworkOutDir,
  hasAllBasicEventTypes,
  incomplete,
  pass,
  prepareGeneratedScenario,
  requireGeneratedScenario,
  runDebugInstrumentedCommand,
  runInstrumentedCommand,
  skip,
  testEventSamples,
  tailInterestingLines,
  testsForDiscoveredScenario,
  testsForScenario,
}
