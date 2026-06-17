'use strict'

const fs = require('fs')
const zlib = require('zlib')

const VALIDATION_APP_PATH = 'ci/test/validation'

const CHECKS = {
  'basic-reporting': {
    id: 'basic-reporting',
    name: 'Basic reporting',
  },
  efd: {
    id: 'efd-new-test-detection-and-retry',
    name: 'EFD new test detection and retry',
  },
  atr: {
    id: 'auto-test-retries',
    name: 'Auto test retries',
  },
  'test-management': {
    id: 'test-management',
    name: 'Test Management',
  },
}

function buildValidationPayloads ({ manifest, results, artifacts }) {
  const payloads = []
  const frameworks = new Map(manifest.frameworks.map(framework => [framework.id, framework]))
  const resultsByFramework = groupBy(results, result => result.frameworkId)

  for (const [frameworkId, frameworkResults] of resultsByFramework) {
    const framework = frameworks.get(frameworkId)
    const payload = buildFrameworkPayload({ framework, frameworkResults, artifacts })
    payloads.push({
      frameworkId,
      payload,
      url: getValidationAppUrl(payload),
    })
  }

  return payloads
}

function buildFrameworkPayload ({ framework, frameworkResults, artifacts }) {
  const checks = frameworkResults
    .map(result => buildCheck({ result }))
    .filter(Boolean)

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status: checks.some(check => check.status === 'failed') ? 'failed' : 'ok',
    checks,
    artifacts: {
      htmlFileUrl: artifacts.htmlFileUrl,
      htmlPath: artifacts.htmlPath,
    },
    framework: framework
      ? {
          id: framework.framework,
          name: getFrameworkName(framework.framework),
          version: framework.frameworkVersion,
        }
      : {
          id: frameworkResults[0].frameworkId,
          name: frameworkResults[0].frameworkId,
          version: 'unknown',
        },
  }
}

function buildCheck ({ result }) {
  if (result.scenario === 'all') {
    return buildStaticOnlyCheck(result)
  }

  if (result.scenario === 'basic-reporting') {
    return buildBasicReportingCheck(result)
  }

  const definition = CHECKS[result.scenario]
  if (!definition) return null

  return {
    id: definition.id,
    name: definition.name,
    status: toUiStatus(result.status),
    reason: result.status === 'fail' || result.status === 'error' ? result.diagnosis : undefined,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: result.status === 'skip' ? 'skipped' : 'ok',
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getRunTestsStatus(result),
        command: readResultCommand(result),
        exitCode: stringify(result.evidence.commandExitCode),
      },
      {
        id: getFeatureCheckStepId(result.scenario),
        name: getFeatureCheckStepName(result.scenario),
        status: toUiStatus(result.status),
        evidence: withReason(result.evidence, result),
      },
    ],
  }
}

function buildStaticOnlyCheck (result) {
  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status: toUiStatus(result.status),
    reason: result.diagnosis,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: 'skipped',
        evidence: {
          reason: 'live fake intake was not started',
        },
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: 'skipped',
        result: 'skipped',
        evidence: {
          reason: 'live validation was skipped before running tests',
        },
      },
      {
        id: 'check-events',
        name: 'Check that events show up',
        status: toUiStatus(result.status),
        evidence: {
          citestcyclePayloads: 0,
          decodeErrors: 0,
          events: {
            modules: 0,
            sessions: 0,
            suites: 0,
            tests: 0,
          },
          missingLevels: ['test_session_end', 'test_module_end', 'test_suite_end', 'test'],
          reason: result.diagnosis,
          requestCount: 0,
        },
      },
    ],
  }
}

function buildBasicReportingCheck (result) {
  const evidence = result.evidence || {}
  const eventCounts = {
    sessions: evidence.testSessionEvents || 0,
    modules: evidence.testModuleEvents || 0,
    suites: evidence.testSuiteEvents || 0,
    tests: evidence.testEvents || 0,
  }

  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status: toUiStatus(result.status),
    reason: result.status === 'fail' || result.status === 'error' ? result.diagnosis : undefined,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: result.status === 'skip' ? 'skipped' : 'ok',
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getRunTestsStatus(result),
        command: readResultCommand(result),
        exitCode: stringify(evidence.commandExitCode),
      },
      {
        id: 'check-events',
        name: 'Check that events show up',
        status: toUiStatus(result.status),
        evidence: {
          decodeErrors: 0,
          events: eventCounts,
          missingLevels: getMissingLevels(eventCounts),
          reason: result.status === 'fail' || result.status === 'error' ? result.diagnosis : undefined,
          samples: evidence.samples,
        },
      },
    ],
  }
}

function getRunTestsStatus (result) {
  if (result.status === 'skip') return 'skipped'
  if (result.evidence.commandExitCode === undefined) return toUiStatus(result.status)
  return result.evidence.commandExitCode === 0 ? 'ok' : 'failed'
}

function getMissingLevels (events) {
  const missing = []
  if (events.sessions === 0) missing.push('test_session_end')
  if (events.modules === 0) missing.push('test_module_end')
  if (events.suites === 0) missing.push('test_suite_end')
  if (events.tests === 0) missing.push('test')
  return missing
}

function getFeatureCheckStepId (scenario) {
  if (scenario === 'efd') return 'check-new-test-retried'
  if (scenario === 'atr') return 'check-passing-execution-marked-retry'
  if (scenario === 'test-management') return 'check-managed-test-tags'
  return 'check-result'
}

function getFeatureCheckStepName (scenario) {
  if (scenario === 'efd') return 'Check that new test is retried'
  if (scenario === 'atr') return 'Check passing execution marked retry'
  if (scenario === 'test-management') return 'Check managed test tags'
  return 'Check result'
}

function withReason (evidence, result) {
  if (result.status !== 'fail' && result.status !== 'error') return evidence
  return {
    ...evidence,
    reason: result.diagnosis,
  }
}

function readResultCommand (result) {
  const commandArtifact = (result.artifacts || []).find(artifact => artifact.endsWith('/command.json'))
  if (!commandArtifact) return

  try {
    return JSON.parse(fs.readFileSync(commandArtifact, 'utf8')).command
  } catch {}
}

function toUiStatus (status) {
  if (status === 'pass') return 'ok'
  if (status === 'fail' || status === 'error') return 'failed'
  if (status === 'skip' || status === 'skipped') return 'skipped'
  return 'unknown'
}

function getValidationAppUrl (payload) {
  return `${VALIDATION_APP_PATH}#pako:${encodeValidationPayload(payload)}`
}

function encodeValidationPayload (payload) {
  return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url')
}

function groupBy (values, getKey) {
  const groups = new Map()
  for (const value of values) {
    const key = getKey(value)
    const group = groups.get(key) || []
    group.push(value)
    groups.set(key, group)
  }
  return groups
}

function getFrameworkName (framework) {
  return {
    cucumber: 'Cucumber',
    cypress: 'Cypress',
    jest: 'Jest',
    mocha: 'Mocha',
    playwright: 'Playwright',
    vitest: 'Vitest',
  }[framework] || framework
}

function stringify (value) {
  return value === undefined ? undefined : String(value)
}

module.exports = {
  buildValidationPayloads,
  encodeValidationPayload,
  getValidationAppUrl,
}
