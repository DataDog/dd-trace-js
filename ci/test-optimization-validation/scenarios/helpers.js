'use strict'

const fs = require('fs')
const path = require('path')

const { buildDatadogEnv, runCommand } = require('../command-runner')
const {
  cleanupGeneratedRuntimeFiles,
  findGeneratedScenario,
  writeGeneratedFiles,
} = require('../generated-files')
const {
  eventsOfType,
  findTestsByIdentity,
  normalizeRequests,
} = require('../payload-normalizer')

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-?]*[ -/]*[@-~]`}`, 'g')

function frameworkOutDir (out, framework, scenario) {
  return path.join(out, 'runs', sanitize(framework.id), scenario)
}

function sanitize (value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

async function runInstrumentedCommand ({ framework, intake, out, scenarioName, command, options, extraEnv }) {
  const outDir = frameworkOutDir(out, framework, scenarioName)
  intake.resetRequests()
  const result = await runCommand(command, {
    env: {
      ...buildDatadogEnv({ intake, scenario: scenarioName, framework }),
      ...extraEnv,
    },
    outDir,
    label: `${framework.id}:${scenarioName}`,
    verbose: options.verbose,
  })

  await wait(1000)
  const events = normalizeRequests(intake.requests)
  fs.writeFileSync(path.join(outDir, 'events.ndjson'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)

  return { result, events, outDir }
}

async function failWithDebugRerun ({
  command,
  configureIntake,
  diagnosis,
  evidence,
  framework,
  intake,
  options,
  out,
  outDir,
  scenarioName,
  skipDebug,
}) {
  if (!skipDebug && command) {
    const debugRerun = await runDebugInstrumentedCommand({
      command,
      configureIntake,
      framework,
      intake,
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
  configureIntake,
  framework,
  intake,
  options,
  out,
  scenarioName,
}) {
  try {
    cleanupGeneratedRuntimeFiles(framework)
    if (configureIntake) configureIntake()

    const debug = await runInstrumentedCommand({
      framework,
      intake,
      out,
      scenarioName: `${scenarioName}-debug`,
      command,
      options,
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
  const written = await writeGeneratedFiles(framework)
  return { scenario, written }
}

function requireGeneratedScenario (framework, scenarioId, scenarioName) {
  const strategy = framework.generatedTestStrategy
  if (!strategy || strategy.status !== 'verified') {
    return skip(framework, scenarioName, 'No verified generated test strategy is available.')
  }

  const scenario = findGeneratedScenario(framework, scenarioId)
  if (!scenario) {
    return skip(framework, scenarioName, `Generated scenario "${scenarioId}" is not present in the manifest.`)
  }

  return null
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

function requestsUrlIncludes (intake, fragment) {
  return intake.requests.some(request => request.url && request.url.includes(fragment))
}

function testsForScenario (events, scenario) {
  return findTestsByIdentity(events, scenario.testIdentities || [])
}

async function discoverScenarioTests ({ framework, intake, out, scenarioName, scenario, options }) {
  intake.configure()
  const baseline = await runInstrumentedCommand({
    framework,
    intake,
    out,
    scenarioName: `${scenarioName}-baseline`,
    command: scenario.runCommand,
    options,
  })
  const tests = testsForScenario(baseline.events, scenario)
  cleanupGeneratedRuntimeFiles(framework)
  return {
    ...baseline,
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
  return output
    .split(/\r?\n/)
    .map(stripAnsi)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
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

function pass (framework, scenario, diagnosis, evidence, outDir) {
  return result(framework, scenario, 'pass', diagnosis, evidence, outDir)
}

function fail (framework, scenario, diagnosis, evidence, outDir) {
  return result(framework, scenario, 'fail', diagnosis, evidence, outDir)
}

function skip (framework, scenario, diagnosis, evidence = {}) {
  return result(framework, scenario, 'skip', diagnosis, evidence, null)
}

function error (framework, scenario, err, outDir) {
  return result(framework, scenario, 'error', err && err.stack ? err.stack : String(err), {}, outDir)
}

function result (framework, scenario, status, diagnosis, evidence, outDir) {
  return {
    frameworkId: framework.id,
    scenario,
    status,
    diagnosis,
    evidence,
    artifacts: outDir
      ? [
          path.join(outDir, 'command.json'),
          path.join(outDir, 'stdout.txt'),
          path.join(outDir, 'stderr.txt'),
          path.join(outDir, 'events.ndjson'),
          path.join(outDir, 'result.json'),
        ]
      : [],
  }
}

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  pass,
  prepareGeneratedScenario,
  requestsUrlIncludes,
  requireGeneratedScenario,
  runDebugInstrumentedCommand,
  runInstrumentedCommand,
  skip,
  testEventSamples,
  tailInterestingLines,
  testsForDiscoveredScenario,
  testsForScenario,
}
