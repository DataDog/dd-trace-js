'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const zlib = require('node:zlib')

const VALIDATION_APP_PATH = 'ci/test/validation'
const TEST_MANAGEMENT_REQUIRED_SUBCHECKS = [
  ['disabled', 'Disabled tests'],
  ['quarantined', 'Quarantined tests'],
  ['attemptToFix', 'Attempt-to-fix tests'],
]

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    fromReports: [],
    strictTestManagement: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--from-report') {
      options.fromReports.push(args[++i])
    } else if (arg.startsWith('--from-report=')) {
      options.fromReports.push(arg.slice('--from-report='.length))
    } else if (arg === '--static-report') {
      options.staticReport = args[++i]
    } else if (arg.startsWith('--static-report=')) {
      options.staticReport = arg.slice('--static-report='.length)
    } else if (arg === '--diagnosis') {
      options.diagnosis = args[++i]
    } else if (arg.startsWith('--diagnosis=')) {
      options.diagnosis = arg.slice('--diagnosis='.length)
    } else if (arg === '--framework-file') {
      options.frameworkFile = args[++i]
    } else if (arg.startsWith('--framework-file=')) {
      options.frameworkFile = arg.slice('--framework-file='.length)
    } else if (arg === '--test-command-file') {
      options.testCommandFile = args[++i]
    } else if (arg.startsWith('--test-command-file=')) {
      options.testCommandFile = arg.slice('--test-command-file='.length)
    } else if (arg === '--test-result-file') {
      options.testResultFile = args[++i]
    } else if (arg.startsWith('--test-result-file=')) {
      options.testResultFile = arg.slice('--test-result-file='.length)
    } else if (arg === '--strict-test-management') {
      options.strictTestManagement = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      options.unknown = arg
    }
  }

  return options
}

/**
 * Gets CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-validation-link [--strict-test-management] ' +
      '--from-report <final-report.txt> [--from-report <file> ...]',
    '',
    'Reads Datadog validation payloads from final reports and prints one combined validation path.',
    'Use --strict-test-management for full runbook results that must include all three Test Management subchecks.',
    '',
    'Static-only path:',
    '  --static-report <file>       Build a validation payload when live validation was intentionally skipped.',
    '  --diagnosis <file>           Optional diagnosis JSON with likelyFailureCause.',
    '  --framework-file <file>      Optional selected framework file.',
    '  --test-command-file <file>   Optional selected/skipped command file.',
    '  --test-result-file <file>    Optional selected/skipped result file.',
  ].join('\n')
}

/**
 * Builds the payload rendered by the local Test Optimization validation web app.
 *
 * @param {object} input validation input
 * @param {object} input.analysis intake analysis report
 * @param {object|undefined} input.staticReport static diagnosis report
 * @param {string|undefined} input.testCommand selected test command
 * @param {string|undefined} input.testExitCode selected test command exit code
 * @param {string|undefined} input.testResult selected test command result summary
 * @param {string|undefined} input.newTestSnippet EFD temporary test snippet
 * @param {string|undefined} input.flakyTestSnippet Auto Test Retries temporary flaky test snippet
 * @param {object|undefined} input.artifacts artifact paths and URLs
 * @param {string|undefined} input.framework selected framework id
 * @returns {object} validation payload
 */
function buildValidationPayload (input) {
  const analysis = input.analysis
  const summary = analysis.summary
  const checks = getChecks(input, analysis)
  const status = getChecksStatus(checks)

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status,
    checks,
    artifacts: {
      htmlFileUrl: input.artifacts?.htmlFileUrl || summary.artifacts.htmlFileUrl,
      htmlPath: input.artifacts?.htmlPath || summary.artifacts.htmlPath,
    },
    framework: getFramework(input.staticReport, input.framework),
  }
}

/**
 * Builds a validation payload for repositories where live validation was intentionally skipped.
 *
 * @param {object} input validation input
 * @param {object} input.staticReport static diagnosis report
 * @param {object|undefined} input.diagnosis diagnosis artifact
 * @param {string|undefined} input.framework selected framework id
 * @param {string|undefined} input.testCommand selected or skipped command text
 * @param {string|undefined} input.testResult selected or skipped result text
 * @returns {object} validation payload
 */
function buildStaticValidationPayload (input) {
  const reason = input.diagnosis?.likelyFailureCause ||
    getStaticFrameworkFailureCause(input.staticReport, input.testCommand || '') ||
    'Live validation was skipped because no eligible supported test command was selected.'
  const checks = [
    {
      id: 'basic-reporting',
      name: 'Basic reporting',
      status: 'failed',
      reason,
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
          command: input.testCommand,
          result: input.testResult,
          evidence: {
            reason: 'live validation was skipped before running tests',
          },
        },
        {
          id: 'check-events',
          name: 'Check that events show up',
          status: 'failed',
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
            reason,
            requestCount: 0,
          },
        },
      ],
    },
  ]

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status: 'failed',
    checks,
    artifacts: {},
    framework: getFramework(input.staticReport, input.framework),
  }
}

/**
 * Builds one validation payload from several run-specific validation payloads.
 *
 * @param {Array<object>} payloads validation payloads
 * @param {object} [options] combination options
 * @param {boolean} [options.strictTestManagement] require all Test Management subchecks
 * @returns {object} combined validation payload
 */
function buildCombinedValidationPayload (payloads, options = {}) {
  const compactPayloads = payloads.filter(Boolean)
  const checks = getCombinedChecks(compactPayloads, options)

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status: getChecksStatus(checks),
    checks,
    artifacts: getFirstValue(compactPayloads, 'artifacts') || {},
    framework: getFirstValue(compactPayloads, 'framework'),
  }
}

/**
 * Gets combined validation checks.
 *
 * @param {Array<object>} payloads validation payloads
 * @param {object} options combination options
 * @returns {Array<object>} combined checks
 */
function getCombinedChecks (payloads, options) {
  const checks = []
  const testManagementChecks = []
  const seen = new Set()

  for (const payload of payloads) {
    for (const check of payload.checks || []) {
      if (check.id === 'test-management') {
        testManagementChecks.push(check)
      } else if (!seen.has(check.id)) {
        checks.push(check)
        seen.add(check.id)
      }
    }
  }

  if (testManagementChecks.length > 0) {
    checks.push(getCombinedTestManagementCheck(testManagementChecks, options))
  }

  return checks
}

/**
 * Gets one combined Test Management check from independent subcheck payloads.
 *
 * @param {Array<object>} checks Test Management checks
 * @param {object} options combination options
 * @returns {object} combined Test Management check
 */
function getCombinedTestManagementCheck (checks, options) {
  const steps = [getCombinedTestManagementSetupStep(checks)]

  for (const check of checks) {
    const runStep = findStep(check, 'run-tests')
    const subcheckSteps = (check.steps || []).filter(step => (
      step.id !== 'setup-intake' &&
      step.id !== 'run-tests' &&
      step.status !== 'skipped'
    ))

    for (const subcheckStep of subcheckSteps) {
      if (runStep) {
        steps.push({
          ...runStep,
          id: `run-tests-${subcheckStep.id}`,
          name: `${subcheckStep.name}: run test`,
          status: subcheckStep.status === 'ok' ? 'ok' : runStep.status,
        })
      }
      steps.push(subcheckStep)
    }
  }

  if (options.strictTestManagement) {
    pushMissingTestManagementSubchecks(steps)
  }

  return {
    id: 'test-management',
    name: 'Test Management',
    status: getChecksStatusFromSteps(steps),
    steps,
  }
}

/**
 * Adds failed placeholders for required Test Management subchecks missing from a strict full result.
 *
 * @param {Array<object>} steps combined Test Management steps
 */
function pushMissingTestManagementSubchecks (steps) {
  const present = new Set(steps.map(step => step.id))

  for (const [id, name] of TEST_MANAGEMENT_REQUIRED_SUBCHECKS) {
    if (present.has(id)) continue

    steps.push({
      id,
      name,
      status: 'failed',
      evidence: {
        reason: 'missing required Test Management subcheck in strict mode',
        tests: 0,
      },
    })
  }
}

/**
 * Gets one combined Test Management setup step.
 *
 * @param {Array<object>} checks Test Management checks
 * @returns {object} setup step
 */
function getCombinedTestManagementSetupStep (checks) {
  const setupSteps = checks.map(check => findStep(check, 'setup-intake')).filter(Boolean)
  const returnedPropertyIdentities = []
  const matchedPropertyIdentities = []
  const unmatchedPropertyIdentities = []
  const samples = []
  let settingsEnabled = false
  let propertiesEndpointCalled = false
  let propertiesReturned = 0

  for (const step of setupSteps) {
    settingsEnabled = settingsEnabled || !!step.evidence?.settingsEnabled
    propertiesEndpointCalled = propertiesEndpointCalled || !!step.evidence?.propertiesEndpointCalled
    propertiesReturned += step.evidence?.propertiesReturned || 0
    pushAll(returnedPropertyIdentities, step.evidence?.returnedPropertyIdentities)
    pushAll(matchedPropertyIdentities, step.evidence?.matchedPropertyIdentities)
    pushAll(unmatchedPropertyIdentities, step.evidence?.unmatchedPropertyIdentities)
    pushAll(samples, step.evidence?.samples)
  }

  return {
    id: 'setup-intake',
    name: 'Set up Test Management intake',
    status: setupSteps.every(step => step.status === 'ok') ? 'ok' : 'failed',
    evidence: withSamples({
      settingsEnabled,
      propertiesEndpointCalled,
      propertiesReturned,
      returnedPropertyIdentities,
      matchedPropertyIdentities,
      unmatchedPropertyIdentities,
    }, samples),
  }
}

/**
 * Gets a check status from child steps.
 *
 * @param {Array<object>} steps validation steps
 * @returns {string} check status
 */
function getChecksStatusFromSteps (steps) {
  if (steps.some(step => step.status === 'failed')) return 'failed'
  if (steps.some(step => step.status === 'unknown')) return 'unknown'
  if (steps.every(step => step.status === 'skipped')) return 'skipped'

  return 'ok'
}

/**
 * Finds a validation step by id.
 *
 * @param {object} check validation check
 * @param {string} id step id
 * @returns {object|undefined} validation step
 */
function findStep (check, id) {
  return (check.steps || []).find(step => step.id === id)
}

/**
 * Appends array values.
 *
 * @param {Array<unknown>} target target array
 * @param {Array<unknown>|undefined} values values to append
 */
function pushAll (target, values) {
  if (!Array.isArray(values)) return

  for (const value of values) {
    target.push(value)
  }
}

/**
 * Adds compact event samples to an evidence object when present.
 *
 * @param {object} evidence validation evidence
 * @param {Array<object>|undefined} samples compact samples
 * @param {number} [limit] maximum samples to include
 * @returns {object} evidence with samples when available
 */
function withSamples (evidence, samples, limit) {
  const sampleSlice = getSampleSlice(samples, limit)
  if (sampleSlice.length === 0) return evidence

  return {
    ...evidence,
    samples: sampleSlice,
  }
}

/**
 * Gets a bounded list of compact samples.
 *
 * @param {Array<object>|undefined} samples compact samples
 * @param {number} [limit] maximum samples to include
 * @returns {Array<object>} bounded samples
 */
function getSampleSlice (samples, limit = 3) {
  if (!Array.isArray(samples)) return []

  return samples.slice(0, limit)
}

/**
 * Gets basic event samples with the selected command as fallback for command-bearing levels.
 *
 * @param {Array<object>|undefined} samples basic event samples
 * @param {string|undefined} testCommand selected test command
 * @returns {Array<object>} compact basic samples
 */
function getBasicSamples (samples, testCommand) {
  if (!Array.isArray(samples)) return []

  return samples.map(sample => {
    if (
      testCommand &&
      !sample['test.command'] &&
      (sample.level === 'test session' || sample.level === 'test module')
    ) {
      return {
        ...sample,
        'test.command': testCommand,
      }
    }

    return sample
  })
}

/**
 * Gets the first present payload field.
 *
 * @param {Array<object>} payloads validation payloads
 * @param {string} key field key
 * @returns {unknown} field value
 */
function getFirstValue (payloads, key) {
  return payloads.find(payload => payload[key])?.[key]
}

/**
 * Gets validation checks.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {Array<object>} validation checks
 */
function getChecks (input, analysis) {
  const checks = [getBasicReportingCheck(input, analysis)]

  if (isEfdCheckAttempted(input, analysis)) {
    checks.push(getEfdCheck(input, analysis))
  }

  if (isAutoTestRetriesCheckAttempted(input, analysis)) {
    checks.push(getAutoTestRetriesCheck(input, analysis))
  }

  if (isTestManagementCheckAttempted(analysis)) {
    checks.push(getTestManagementCheck(input, analysis))
  }

  return checks
}

/**
 * Gets the overall check status.
 *
 * @param {Array<object>} checks validation checks
 * @returns {string} status
 */
function getChecksStatus (checks) {
  return checks.some(check => check.status === 'failed') ? 'failed' : 'ok'
}

/**
 * Gets the basic reporting validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} basic reporting check
 */
function getBasicReportingCheck (input, analysis) {
  const summary = analysis.summary
  const events = getEventCounts(summary)
  const status = getBasicReportingStatus(summary)
  const reason = status === 'failed' ? getBasicReportingFailureCause(input, analysis) : undefined

  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status,
    reason,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.artifacts.intakeUrl ? 'ok' : 'failed',
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-events',
        name: 'Check that events show up',
        status,
        evidence: withSamples({
          requestCount: summary.requestCount,
          citestcyclePayloads: summary.citestcycle.payloadCount,
          events,
          genericSpanEvents: summary.events.counts.span || 0,
          observedEventTypes: getObservedEventTypes(summary),
          missingLevels: summary.events.missingLevels,
          decodeErrors: summary.decodeErrors.length,
          reason,
        }, getBasicSamples(summary.events.samples, input.testCommand), 4),
      },
    ],
  }
}

/**
 * Gets the likely failure cause for a failed basic-reporting check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {string} likely failure cause
 */
function getBasicReportingFailureCause (input, analysis) {
  const summary = analysis.summary
  const staticCause = getStaticFrameworkFailureCause(input.staticReport, input.testCommand || '')

  if (staticCause) return staticCause
  if (summary.citestcycle.payloadCount === 0) {
    return 'No Test Optimization payload reached the fake intake. The tracer may not have loaded, the selected ' +
      'command may not have run tests, or the selected runner may not be supported.'
  }
  if (hasOnlyGenericSpanEvents(summary)) {
    return getGenericSpanOnlyFailureCause(input)
  }
  if (summary.events.missingLevels.includes('test')) {
    return 'Test Optimization initialized and emitted higher-level events, but per-test hooks did not fire. ' +
      'This usually points to an unsupported runner, unsupported framework version, or unsupported framework ' +
      'configuration for the selected command.'
  }
  if (summary.events.missingLevels.length > 0) {
    return `Test Optimization emitted partial event levels. Missing levels: ${summary.events.missingLevels.join(', ')}.`
  }
  if (summary.decodeErrors.length > 0) {
    return 'The fake intake received payloads but could not decode one or more of them.'
  }

  return 'Basic reporting failed, but no more specific cause was available from the local artifacts.'
}

/**
 * Checks whether CI Visibility payloads contained only generic spans, not test events.
 *
 * @param {object} summary intake summary
 * @returns {boolean} whether only generic spans were observed
 */
function hasOnlyGenericSpanEvents (summary) {
  const counts = summary.events.counts || {}

  return summary.citestcycle.payloadCount > 0 &&
    (counts.span || 0) > 0 &&
    (counts.test_session_end || 0) === 0 &&
    (counts.test_module_end || 0) === 0 &&
    (counts.test_suite_end || 0) === 0 &&
    (counts.test || 0) === 0
}

/**
 * Gets the failure cause for generic-span-only CI Visibility payloads.
 *
 * @param {object} input validation input
 * @returns {string} failure cause
 */
function getGenericSpanOnlyFailureCause (input) {
  const framework = getSelectedFrameworkId(input)
  const base = 'The fake intake received CI Visibility payloads, but they contained generic span events instead ' +
    'of Test Optimization test events.'

  if (framework === 'vitest') {
    return `${base} For Vitest, this usually means the ESM preload did not reach the test worker. Rerun with ` +
      'NODE_OPTIONS="--import dd-trace/register.js -r dd-trace/ci/init" or choose a Vitest command shape that ' +
      'preserves NODE_OPTIONS in workers.'
  }

  return `${base} The selected command likely bypassed the supported test framework instrumentation, used a ` +
    'custom runner configuration, or did not propagate the dd-trace CI init preload to the process that executed tests.'
}

/**
 * Gets selected framework id from validation input.
 *
 * @param {object} input validation input
 * @returns {string|undefined} selected framework id
 */
function getSelectedFrameworkId (input) {
  return input.framework && String(input.framework).toLowerCase()
}

/**
 * Gets observed event type names from the analyzer summary.
 *
 * @param {object} summary intake summary
 * @returns {string[]} observed event type names
 */
function getObservedEventTypes (summary) {
  return Object.entries(summary.events.counts || {})
    .filter(([, count]) => count > 0)
    .map(([type]) => type)
}

/**
 * Gets framework-related failure cause text from static diagnosis.
 *
 * @param {object|undefined} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {string|undefined} framework failure cause
 */
function getStaticFrameworkFailureCause (staticReport, testCommand) {
  if (!staticReport) return

  const unsupportedFramework = getUnsupportedFrameworkCause(staticReport, testCommand)
  if (unsupportedFramework) return unsupportedFramework

  const unsupportedVersion = getUnsupportedVersionCause(staticReport, testCommand)
  if (unsupportedVersion) return unsupportedVersion

  const frameworkConfiguration = getFrameworkConfigurationCause(staticReport, testCommand)
  if (frameworkConfiguration) return frameworkConfiguration
}

/**
 * Gets unsupported-framework cause text from static diagnosis.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {string|undefined} unsupported framework cause
 */
function getUnsupportedFrameworkCause (staticReport, testCommand) {
  const frameworks = Array.isArray(staticReport.unsupportedFrameworks) ? staticReport.unsupportedFrameworks : []
  if (frameworks.length === 0) return

  const normalizedCommand = testCommand.toLowerCase()
  const selected = frameworks.filter(framework => commandMatchesUnsupportedFramework(normalizedCommand, framework))
  let relevant = selected

  if (relevant.length === 0 && !normalizedCommand) {
    relevant = frameworks
  }

  if (relevant.length === 0) return

  return `Selected command appears to use unsupported test framework(s): ${
    relevant.map(framework => framework.name).join(', ')
  }. Choose a supported framework before running the live validation.`
}

/**
 * Checks whether a command appears to invoke an unsupported framework.
 *
 * @param {string} command selected command
 * @param {object} framework unsupported framework summary
 * @returns {boolean} whether the command matches the framework
 */
function commandMatchesUnsupportedFramework (command, framework) {
  if (framework.id === 'node-test') return /\bnode\s+--test\b|\bnode:test\b/.test(command)
  if (framework.id === 'testcafe') return /\btestcafe\b/.test(command)

  return command.includes(String(framework.id).toLowerCase()) ||
    command.includes(String(framework.name).toLowerCase())
}

/**
 * Gets unsupported-version cause text from static diagnosis.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected command
 * @returns {string|undefined} unsupported version cause
 */
function getUnsupportedVersionCause (staticReport, testCommand) {
  const findings = (Array.isArray(staticReport.results) ? staticReport.results : [])
    .filter(finding => finding.status === 'error' && /\bis not supported\b/.test(finding.title || ''))
  if (findings.length === 0) return

  const normalizedCommand = testCommand.toLowerCase()
  const selected = findings.filter(finding => normalizedCommand.includes(getFindingFrameworkName(finding)))
  const relevant = dedupeFindings(selected.length > 0 ? selected : findings)

  return `Static diagnosis found unsupported framework version(s): ${
    relevant.map(finding => finding.title).join('; ')
  }. ${relevant.map(finding => finding.recommendation).filter(Boolean).join(' ')}`
}

/**
 * Deduplicates repeated static findings.
 *
 * @param {object[]} findings static diagnosis findings
 * @returns {object[]} deduplicated findings
 */
function dedupeFindings (findings) {
  const seen = new Set()
  const deduped = []

  for (const finding of findings) {
    const key = `${finding.status || ''}|${finding.title || ''}|${finding.recommendation || ''}`
    if (seen.has(key)) continue

    seen.add(key)
    deduped.push(finding)
  }

  return deduped
}

/**
 * Gets framework-configuration cause text from static diagnosis.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected command
 * @returns {string|undefined} framework configuration cause
 */
function getFrameworkConfigurationCause (staticReport, testCommand) {
  const findings = (Array.isArray(staticReport.results) ? staticReport.results : [])
    .filter(finding => finding.status === 'warning' && /^Jest TypeScript config may need ts-node$/.test(
      finding.title || ''
    ))
  if (findings.length === 0) return

  const command = testCommand.toLowerCase()
  const supportedFrameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  const appearsToUseJest = /\bjest\b/.test(command) ||
    /\bnpm\s+(?:run\s+)?test\b/.test(command) ||
    (supportedFrameworks.length === 1 && supportedFrameworks[0].id === 'jest')

  if (!appearsToUseJest) return

  return `Static diagnosis found Jest configuration risk: ${
    findings.map(finding => finding.title).join('; ')
  }. ${findings.map(finding => finding.recommendation).filter(Boolean).join(' ')}`
}

/**
 * Gets a normalized framework name from a static finding.
 *
 * @param {object} finding static finding
 * @returns {string} normalized framework name
 */
function getFindingFrameworkName (finding) {
  return String(finding.title || '').split(/\s+/)[0].toLowerCase()
}

/**
 * Gets the EFD validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} EFD check
 */
function getEfdCheck (input, analysis) {
  const summary = analysis.summary
  const status = getEfdStatus(summary)

  return {
    id: 'efd-new-test-detection-and-retry',
    name: 'EFD new test detection and retry',
    status,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.efd.settingsEnabled && summary.efd.requested ? 'ok' : 'failed',
        evidence: {
          settingsEnabled: summary.efd.settingsEnabled,
          knownTestsRequested: summary.efd.requested,
          knownTestsReceived: summary.efd.knownTestsReceived,
        },
      },
      {
        id: 'add-new-test',
        name: 'Add new test',
        status: input.newTestSnippet || summary.efd.newTests.length > 0 ? 'ok' : 'failed',
        snippet: input.newTestSnippet,
        evidence: {
          newTestsObserved: summary.efd.newTests.length,
          retriedNewTestNames: summary.efd.retriedNewTestNames,
        },
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-new-test-retried',
        name: 'Check that new test is retried',
        status,
        evidence: withSamples({
          retriedNewTests: summary.efd.retriedNewTests,
          retriedNewTestNames: summary.efd.retriedNewTestNames,
        }, summary.efd.samples),
      },
    ],
  }
}

/**
 * Gets the Auto Test Retries validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} Auto Test Retries check
 */
function getAutoTestRetriesCheck (input, analysis) {
  const summary = analysis.summary
  const status = getAutoTestRetriesStatus(summary)

  return {
    id: 'auto-test-retries',
    name: 'Auto test retries',
    status,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.atr.settingsEnabled ? 'ok' : 'failed',
        evidence: {
          settingsEnabled: summary.atr.settingsEnabled,
        },
      },
      {
        id: 'make-known-test-flaky',
        name: 'Make an already known test flaky',
        status: input.flakyTestSnippet || summary.atr.failedExecutions > 0 ? 'ok' : 'failed',
        snippet: input.flakyTestSnippet,
        evidence: {
          failedExecutions: summary.atr.failedExecutions,
          failedThenPassedRetryTestNames: summary.atr.failedThenPassedRetryTestNames,
        },
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-failing-and-passing-executions',
        name: 'Check that failing and passing executions were reported',
        status: summary.atr.failedExecutions > 0 && summary.atr.passedExecutions > 0 ? 'ok' : 'failed',
        evidence: withSamples({
          failedExecutions: summary.atr.failedExecutions,
          passedExecutions: summary.atr.passedExecutions,
          failedThenPassedRetryTests: summary.atr.failedThenPassedRetryTests,
          failedThenPassedRetryTestNames: summary.atr.failedThenPassedRetryTestNames,
        }, summary.atr.samples),
      },
      {
        id: 'check-passing-execution-marked-retry',
        name: 'Check that the passing execution is marked as a retry',
        status,
        evidence: {
          passedRetryTests: summary.atr.passedRetryTests,
          passedRetryTestNames: summary.atr.passedRetryTestNames,
          retriedTests: summary.atr.retriedTests,
          retriedTestNames: summary.atr.retriedTestNames,
        },
      },
    ],
  }
}

/**
 * Gets the Test Management validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} Test Management check
 */
function getTestManagementCheck (input, analysis) {
  const summary = analysis.summary
  const subchecks = [
    getTestManagementSubcheck(input, summary, 'disabled', 'Disabled tests', '0'),
    getTestManagementSubcheck(input, summary, 'quarantined', 'Quarantined tests', '0'),
    getTestManagementSubcheck(input, summary, 'attemptToFix', 'Attempt-to-fix tests', 'non-zero'),
  ]

  return {
    id: 'test-management',
    name: 'Test Management',
    status: getTestManagementStatus(summary, subchecks),
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up Test Management intake',
        status: summary.tm.settingsEnabled && summary.tm.propertiesEndpointCalled ? 'ok' : 'failed',
        evidence: withSamples({
          settingsEnabled: summary.tm.settingsEnabled,
          propertiesEndpointCalled: summary.tm.propertiesEndpointCalled,
          propertiesReturned: summary.tm.returnedProperties,
          returnedPropertyIdentities: summary.tm.returnedPropertyIdentities,
          matchedPropertyIdentities: summary.tm.matchedPropertyIdentities,
          unmatchedPropertyIdentities: summary.tm.unmatchedPropertyIdentities,
        }, summary.tm.managedTests.samples),
      },
      {
        id: 'run-tests',
        name: 'Run managed test',
        status: getTestManagementRunTestStatus(input, summary),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      ...subchecks,
    ],
  }
}

/**
 * Gets one Test Management subcheck step.
 *
 * @param {object} input validation input
 * @param {object} summary intake summary
 * @param {string} id subcheck id
 * @param {string} name subcheck name
 * @param {string} expectedExitCode expected command exit code
 * @returns {object} validation step
 */
function getTestManagementSubcheck (input, summary, id, name, expectedExitCode) {
  const subcheck = summary.tm[id]
  const expectedSubcheck = summary.tm.expectedSubcheck
  const skipped = expectedSubcheck && expectedSubcheck !== id

  return {
    id,
    name,
    status: skipped ? 'skipped' : getTestManagementSubcheckStatus(input, subcheck, expectedExitCode),
    evidence: withSamples({
      expectedExitCode,
      actualExitCode: input.testExitCode,
      managedTestIdentities: subcheck.identities,
      observedStatuses: subcheck.observedStatuses,
      observedFinalStatuses: subcheck.observedFinalStatuses,
      observedRetryReasons: subcheck.observedRetryReasons,
      reason: skipped ? `not run in ${summary.tm.expectedSubcheck} mode` : subcheck.reason,
      tests: subcheck.tests,
    }, subcheck.samples),
  }
}

/**
 * Checks whether the EFD check was attempted.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if EFD evidence is present
 */
function isEfdCheckAttempted (input, analysis) {
  const efd = analysis.summary.efd
  return !!(
    input.newTestSnippet ||
    efd.settingsEnabled ||
    efd.requested ||
    efd.knownTestsReceived > 0 ||
    efd.newTests.length > 0 ||
    efd.retriedNewTests > 0
  )
}

/**
 * Checks whether the Auto Test Retries check was attempted.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if Auto Test Retries evidence is present
 */
function isAutoTestRetriesCheckAttempted (input, analysis) {
  const atr = analysis.summary.atr
  return !!(
    input.flakyTestSnippet ||
    atr.settingsEnabled ||
    atr.retriedTests > 0 ||
    atr.failedThenPassedRetryTests > 0
  )
}

/**
 * Checks whether the Test Management check was attempted.
 *
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if Test Management evidence is present
 */
function isTestManagementCheckAttempted (analysis) {
  const tm = analysis.summary.tm

  return !!(
    tm.settingsEnabled ||
    tm.propertiesEndpointCalled ||
    tm.returnedProperties > 0 ||
    tm.managedTests.count > 0 ||
    tm.expectedSubcheck
  )
}

/**
 * Gets basic reporting check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getBasicReportingStatus (summary) {
  if (summary.citestcycle.payloadCount === 0) return 'failed'
  if (summary.events.missingLevels.length > 0) return 'failed'
  if (summary.decodeErrors.length > 0) return 'failed'

  return 'ok'
}

/**
 * Gets EFD check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getEfdStatus (summary) {
  if (!summary.efd.settingsEnabled) return 'failed'
  if (!summary.efd.requested) return 'failed'
  if (summary.efd.knownTestsReceived === 0) return 'failed'
  if (summary.efd.retriedNewTests === 0) return 'failed'

  return 'ok'
}

/**
 * Gets Auto Test Retries check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getAutoTestRetriesStatus (summary) {
  if (!summary.atr.settingsEnabled) return 'failed'
  if (summary.atr.failedExecutions === 0) return 'failed'
  if (summary.atr.passedExecutions === 0) return 'failed'
  if (summary.atr.passedRetryTests === 0) return 'failed'
  if (summary.atr.failedThenPassedRetryTests === 0) return 'failed'

  return 'ok'
}

/**
 * Gets the aggregate Test Management check status.
 *
 * @param {object} summary intake summary
 * @param {Array<object>} subchecks Test Management subcheck steps
 * @returns {string} check status
 */
function getTestManagementStatus (summary, subchecks) {
  if (
    !summary.tm.settingsEnabled ||
    !summary.tm.propertiesEndpointCalled ||
    summary.tm.returnedProperties === 0 ||
    summary.tm.unmatchedPropertyIdentities.length > 0
  ) {
    return 'failed'
  }

  const attempted = subchecks.filter(subcheck => subcheck.status !== 'skipped')
  if (attempted.length === 0) return 'skipped'
  if (attempted.some(subcheck => subcheck.status === 'failed')) return 'failed'
  if (attempted.some(subcheck => subcheck.status === 'unknown')) return 'unknown'

  return 'ok'
}

/**
 * Gets a Test Management subcheck status.
 *
 * @param {object} input validation input
 * @param {object} subcheck analyzer subcheck summary
 * @param {string} expectedExitCode expected command exit code
 * @returns {string} validation step status
 */
function getTestManagementSubcheckStatus (input, subcheck, expectedExitCode) {
  if (subcheck.status === 'not run') return 'failed'
  if (subcheck.status !== 'passed') return 'failed'
  if (input.testExitCode === undefined) return 'unknown'

  const exitCode = String(input.testExitCode)
  if (expectedExitCode === 'non-zero') return exitCode === '0' ? 'failed' : 'ok'

  return exitCode === expectedExitCode ? 'ok' : 'failed'
}

/**
 * Gets the Test Management run-test step status.
 *
 * @param {object} input validation input
 * @param {object} summary intake summary
 * @returns {string} step status
 */
function getTestManagementRunTestStatus (input, summary) {
  if (summary.tm.expectedSubcheck === 'attemptToFix') {
    if (input.testExitCode === undefined && !input.testCommand && !input.testResult) return 'unknown'

    return String(input.testExitCode) === '0' ? 'failed' : 'ok'
  }

  return getTestCommandStatus(input)
}

/**
 * Gets test command step status.
 *
 * @param {object} input validation input
 * @returns {string} step status
 */
function getTestCommandStatus (input) {
  if (input.testExitCode === undefined && !input.testCommand && !input.testResult) return 'unknown'

  return input.testExitCode === '0' || input.testExitCode === 0 ? 'ok' : 'failed'
}

/**
 * Gets compact event counts.
 *
 * @param {object} summary intake summary
 * @returns {object} compact event counts
 */
function getEventCounts (summary) {
  return {
    sessions: summary.events.counts.test_session_end,
    modules: summary.events.counts.test_module_end,
    suites: summary.events.counts.test_suite_end,
    tests: summary.events.counts.test,
  }
}

/**
 * Encodes a validation payload with the same deflate format produced by pako.deflate().
 *
 * @param {object} payload validation payload
 * @returns {string} URL-safe base64 encoded deflate payload
 */
function encodeValidationPayload (payload) {
  return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url')
}

/**
 * Decodes a validation payload.
 *
 * @param {string} encoded encoded payload
 * @returns {object} validation payload
 */
function decodeValidationPayload (encoded) {
  return JSON.parse(zlib.inflateSync(Buffer.from(encoded, 'base64url')).toString('utf8'))
}

/**
 * Gets one combined validation web app path from final reports.
 *
 * @param {string[]} reports final report paths
 * @returns {string} combined validation web app path
 */
function getCombinedValidationAppUrlFromReports (reports, options = {}) {
  const payloads = []

  for (const report of reports) {
    const payload = getValidationPayloadFromReport(report)
    if (payload) payloads.push(payload)
  }

  if (payloads.length === 0) {
    throw new Error('No Datadog validation payloads found in the provided reports.')
  }

  return getValidationAppUrl(buildCombinedValidationPayload(payloads, options))
}

/**
 * Gets a validation payload from a final report.
 *
 * @param {string} report final report path
 * @returns {object|undefined} validation payload
 */
function getValidationPayloadFromReport (report) {
  let text

  try {
    text = fs.readFileSync(report, 'utf8')
  } catch {
    return
  }

  const line = text.split(/\r?\n/).find(line => line.startsWith('Datadog validation: '))
  if (!line) return

  const url = line.slice('Datadog validation: '.length).trim()
  const marker = '#pako:'
  const markerIndex = url.indexOf(marker)
  if (markerIndex === -1) return

  return decodeValidationPayload(url.slice(markerIndex + marker.length))
}

/**
 * Gets a validation web app path for a payload.
 *
 * @param {object} payload validation payload
 * @returns {string} validation web app path
 */
function getValidationAppUrl (payload) {
  return `${VALIDATION_APP_PATH}#pako:${encodeValidationPayload(payload)}`
}

/**
 * Gets the detected test framework.
 *
 * @param {object|undefined} staticReport static diagnosis report
 * @returns {object|undefined} framework payload
 */
function getFramework (staticReport, selectedFramework) {
  if (!staticReport) return

  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  const framework = selectedFramework
    ? frameworks.find(framework => framework.id === selectedFramework) || frameworks[0]
    : frameworks[0]
  if (!framework) return

  return {
    id: framework.id,
    name: framework.name,
    version: getFrameworkVersion(framework),
  }
}

/**
 * Gets the first detected framework version.
 *
 * @param {object} framework supported framework summary
 * @returns {string|undefined} framework version
 */
function getFrameworkVersion (framework) {
  const detections = Array.isArray(framework.versionDetections) ? framework.versionDetections : []
  return detections[0]?.version || detections[0]?.rawVersion
}

/**
 * Reads JSON from disk.
 *
 * @param {string|undefined} file file path
 * @param {object} fallback fallback value
 * @returns {object} parsed JSON or fallback
 */
function readJson (file, fallback) {
  if (!file) return fallback

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Reads text from disk.
 *
 * @param {string|undefined} file file path
 * @returns {string|undefined} file text
 */
function readText (file) {
  if (!file) return

  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {}
}

/**
 * Gets a static-only validation web app path.
 *
 * @param {object} options CLI options
 * @returns {string} validation web app path
 */
function getStaticValidationAppUrl (options) {
  const payload = buildStaticValidationPayload({
    diagnosis: readJson(options.diagnosis, {}),
    framework: readText(options.frameworkFile),
    staticReport: readJson(options.staticReport, { results: [] }),
    testCommand: readText(options.testCommandFile),
    testResult: readText(options.testResultFile),
  })

  return getValidationAppUrl(payload)
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else if (options.staticReport) {
    console.log(`Datadog validation: ${getStaticValidationAppUrl(options)}`)
  } else {
    try {
      console.log(`Datadog validation: ${getCombinedValidationAppUrlFromReports(options.fromReports, options)}`)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = {
  buildCombinedValidationPayload,
  buildStaticValidationPayload,
  buildValidationPayload,
  decodeValidationPayload,
  encodeValidationPayload,
  getCombinedValidationAppUrlFromReports,
  getBasicReportingFailureCause,
  getStaticValidationAppUrl,
  getValidationAppUrl,
  getValidationPayloadFromReport,
  parseArgs,
}
