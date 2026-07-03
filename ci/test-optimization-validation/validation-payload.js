'use strict'

const fs = require('fs')
const zlib = require('zlib')

const {
  getCommandDetails,
  serializeDisplayCommand,
} = require('./command-runner')

const VALIDATION_APP_PATH = 'ci/test/validation'

const CHECKS = {
  'ci-wiring': {
    id: 'ci-wiring',
    name: 'CI wiring',
  },
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
    const payload = buildFrameworkPayload({ manifest, framework, frameworkResults, artifacts })
    payloads.push({
      frameworkId,
      payload,
      url: getValidationAppUrl(payload),
    })
  }

  return payloads
}

function buildFrameworkPayload ({ manifest, framework, frameworkResults, artifacts }) {
  const checks = frameworkResults
    .map(result => buildCheck({ result }))
    .filter(Boolean)

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status: getPayloadStatus(checks),
    checks,
    artifacts: {
      htmlFileUrl: artifacts.htmlFileUrl,
      htmlPath: artifacts.htmlPath,
    },
    framework: buildFrameworkContext({ framework, frameworkResults }),
    ciDiscovery: buildCiDiscoveryContext(manifest),
  }
}

function buildCiDiscoveryContext (manifest) {
  if (!manifest?.ciDiscovery) return
  return manifest.ciDiscovery
}

function buildFrameworkContext ({ framework, frameworkResults }) {
  if (!framework) {
    const frameworkId = frameworkResults[0].frameworkId
    return {
      id: frameworkId,
      name: frameworkId,
      version: 'unknown',
      language: 'javascript',
      packageName: null,
      workingDirectory: null,
      commandWorkingDirectory: null,
      projectRoot: null,
      packageJson: null,
    }
  }

  const project = framework.project || {}
  const commandWorkingDirectory = framework.existingTestCommand?.cwd || null

  return {
    id: framework.framework,
    name: getFrameworkName(framework.framework),
    version: framework.frameworkVersion || 'unknown',
    language: framework.language || 'javascript',
    packageName: project.name || readPackageName(project.packageJson) || null,
    workingDirectory: project.root || commandWorkingDirectory,
    commandWorkingDirectory,
    projectRoot: project.root || null,
    packageJson: project.packageJson || null,
  }
}

function readPackageName (packageJsonPath) {
  if (!packageJsonPath) return

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).name
  } catch {}
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
  const commandInfo = readResultCommandInfo(result)

  return {
    id: definition.id,
    name: definition.name,
    status: toUiStatus(result.status),
    reason: isProblemStatus(result.status) ? result.diagnosis : undefined,
    steps: [
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getRunTestsStatus(result),
        command: commandInfo.command,
        exitCode: stringify(result.evidence.commandExitCode),
        evidence: getRunTestsEvidence(commandInfo),
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
  if (result.evidence?.blockedByExecutionEnvironment) {
    return {
      id: 'execution-environment',
      name: 'Local fake intake',
      status: 'unknown',
      reason: result.evidence.reason || result.diagnosis,
      remediation: result.evidence.remediation,
      evidence: getExecutionEnvironmentEvidence(result),
      steps: [],
    }
  }

  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status: toUiStatus(result.status),
    reason: result.diagnosis,
    steps: [],
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
  const status = toUiStatus(result.status)
  const reason = isProblemStatus(result.status) ? result.diagnosis : undefined
  const commandInfo = readResultCommandInfo(result)

  if (isCheckLevelFailure(result)) {
    return {
      id: 'basic-reporting',
      name: 'Basic reporting',
      status,
      reason,
      steps: [],
    }
  }

  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status,
    reason,
    steps: [
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getRunTestsStatus(result),
        command: commandInfo.command,
        exitCode: stringify(evidence.commandExitCode),
        result: getRunTestsResult(result),
        evidence: {
          outputSummary: evidence.commandOutputSummary,
          ...getRunTestsEvidence(commandInfo),
        },
      },
      {
        id: 'check-events',
        name: 'Check that events show up',
        status: toUiStatus(result.status),
        evidence: {
          decodeErrors: 0,
          events: eventCounts,
          missingLevels: getMissingLevels(eventCounts),
          commandFailure: evidence.commandFailure,
          eventLevelFailure: evidence.eventLevelFailure,
          debugRerun: evidence.debugRerun,
          debugExcerpt: getDebugExcerpt(evidence.debugRerun),
          localDiagnosis: evidence.localDiagnosis,
          reason,
          samples: evidence.samples,
        },
      },
    ],
  }
}

function isCheckLevelFailure (result) {
  if (result.status !== 'fail' && result.status !== 'error') return false
  if (result.evidence?.commandExitCode !== undefined) return false
  return !readResultCommand(result)
}

function getRunTestsStatus (result) {
  if (result.status === 'skip') return 'skipped'
  if (result.evidence.commandExitMatchesPreflight === true) return 'ok'
  if (result.evidence.commandExitCode === undefined) return toUiStatus(result.status)
  return result.evidence.commandExitCode === 0 ? 'ok' : 'failed'
}

function getRunTestsResult (result) {
  const evidence = result.evidence || {}
  if (evidence.commandExitMatchesPreflight === true) {
    return `exited ${evidence.commandExitCode}, matching dd-trace-less preflight`
  }
  if (Array.isArray(evidence.commandOutputSummary) && evidence.commandOutputSummary.length > 0) {
    return evidence.commandOutputSummary.join('\n')
  }
}

function getDebugExcerpt (debugRerun) {
  if (!debugRerun || debugRerun.ran !== true) return

  const lines = [
    ...(debugRerun.debugLines || []),
    ...(debugRerun.stderrExcerpt || []),
    ...(debugRerun.stdoutExcerpt || []),
  ]
  const unique = []
  const seen = new Set()

  for (const line of lines) {
    const normalized = String(line || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(line)
    if (unique.length === 8) break
  }

  return unique.length > 0 ? unique : undefined
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
  if (scenario === 'ci-wiring') return 'check-ci-wiring-events'
  if (scenario === 'efd') return 'check-new-test-retried'
  if (scenario === 'atr') return 'check-passing-execution-marked-retry'
  if (scenario === 'test-management') return 'check-managed-test-tags'
  return 'check-result'
}

function getFeatureCheckStepName (scenario) {
  if (scenario === 'ci-wiring') return 'Check CI wiring events'
  if (scenario === 'efd') return 'Check that new test is retried'
  if (scenario === 'atr') return 'Check passing execution marked retry'
  if (scenario === 'test-management') return 'Check managed test tags'
  return 'Check result'
}

function withReason (evidence, result) {
  if (!isProblemStatus(result.status)) return evidence
  return {
    ...evidence,
    reason: result.diagnosis,
  }
}

function readResultCommand (result) {
  return readResultCommandInfo(result).command
}

function readResultCommandInfo (result) {
  const commandArtifact = (result.artifacts || []).find(artifact => artifact.endsWith('/command.json'))
  if (!commandArtifact) return {}

  try {
    const artifact = JSON.parse(fs.readFileSync(commandArtifact, 'utf8'))
    return {
      command: artifact.displayCommand || sanitizeCommand(artifact.command),
      details: artifact.commandDetails || getFallbackCommandDetails(artifact.command),
    }
  } catch {}

  return {}
}

function getRunTestsEvidence (commandInfo) {
  if (!commandInfo.details) return
  return {
    commandDetails: commandInfo.details,
  }
}

function sanitizeCommand (command) {
  if (typeof command !== 'string' || !command) return command
  return serializeDisplayCommand({ argv: command.split(/\s+/), usesShell: false })
}

function getFallbackCommandDetails (command) {
  if (typeof command !== 'string' || !command) return
  return getCommandDetails({ argv: command.split(/\s+/), usesShell: false })
}

function toUiStatus (status) {
  if (status === 'pass') return 'ok'
  if (status === 'blocked') return 'unknown'
  if (status === 'fail' || status === 'error') return 'failed'
  if (status === 'skip' || status === 'skipped') return 'skipped'
  return 'unknown'
}

function getPayloadStatus (checks) {
  if (checks.some(check => check.status === 'failed')) return 'failed'
  if (checks.some(check => check.status === 'unknown')) return 'unknown'
  return 'ok'
}

function getExecutionEnvironmentEvidence (result) {
  const evidence = result.evidence || {}

  return {
    blockedByExecutionEnvironment: true,
    localNetworkingBlocked: evidence.localNetworkingBlocked,
    manifestMayBeReused: evidence.manifestMayBeReused,
    intakeStarted: evidence.intakeStarted,
    error: evidence.error,
    errorCode: evidence.errorCode,
    errorSyscall: evidence.errorSyscall,
    errorAddress: evidence.errorAddress,
    rerunCommand: evidence.rerunCommand,
  }
}

function isProblemStatus (status) {
  return status === 'fail' || status === 'error' || status === 'blocked'
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
