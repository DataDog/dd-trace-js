'use strict'

const fs = require('fs')
const path = require('path')

const { buildDatadogEnv, runCommand } = require('../command-runner')
const { findGeneratedScenario, writeGeneratedFiles } = require('../generated-files')
const {
  eventsOfType,
  findTestsByIdentity,
  normalizeRequests,
} = require('../payload-normalizer')

function frameworkOutDir (out, framework, scenario) {
  return path.join(out, 'runs', sanitize(framework.id), scenario)
}

function sanitize (value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-')
}

async function runInstrumentedCommand ({ framework, intake, out, scenarioName, command, options }) {
  const outDir = frameworkOutDir(out, framework, scenarioName)
  intake.resetRequests()
  const result = await runCommand(command, {
    env: buildDatadogEnv({ intake, scenario: scenarioName }),
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
  error,
  fail,
  frameworkOutDir,
  hasAllBasicEventTypes,
  pass,
  prepareGeneratedScenario,
  requestsUrlIncludes,
  requireGeneratedScenario,
  runInstrumentedCommand,
  skip,
  testsForScenario,
}
