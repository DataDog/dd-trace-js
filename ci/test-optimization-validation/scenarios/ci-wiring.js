'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiRemediation, getConfiguredTransport } = require('../ci-remediation')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { fail, incomplete } = require('./helpers')

// eslint-disable-next-line eslint-rules/eslint-env-aliases
const API_KEY_ENV_ALIAS = 'DATADOG_API_KEY'

/**
 * Audits the recorded CI configuration without executing repository CI commands.
 *
 * @param {object} input audit input
 * @param {object} input.manifest validation manifest
 * @param {object} input.framework framework manifest entry
 * @param {object} [input.basicResult] Basic Reporting result
 * @returns {object} CI configuration audit result
 */
function runCiWiring ({ manifest, framework, basicResult }) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return incomplete(framework, 'ci-wiring',
      `The CI configuration audit is incomplete: ${contradiction.reason}`, {
        ciCommandCandidate: buildCiCommandCandidate(framework),
        ciWiring: framework.ciWiring,
        ciDiscovery: contradiction.ciDiscovery,
        conclusion: 'incomplete',
        domain: 'ci_configuration',
        evidenceStrength: 'unknown',
        recommendation: contradiction.recommendation,
      })
  }

  const ciWiring = framework.ciWiring || {}
  const ciScope = getCiScope(ciWiring)
  const ciRemediation = buildCiRemediation(framework)
  const nodeOptionsRemoval = findNodeOptionsRemoval(framework, manifest)
  const initializationStatus = getStaticInitializationStatus(framework)
  const transport = getConfiguredTransport(framework)
  const apiKeyConfigured = hasApiKeyReference(framework)
  const evidence = {
    ciCommandCandidate: buildCiCommandCandidate(framework),
    ciWiring,
    ciRemediation,
    directInitializationBasicReporting: summarizeBasicReportingResult(basicResult),
    initializationStatus,
    nodeOptionsRemoval,
    transport,
    apiKeyConfigured,
    domain: 'ci_configuration',
    evidenceStrength: 'confirmed_static',
  }

  if (nodeOptionsRemoval) {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = getNodeOptionsRemovalRecommendation(nodeOptionsRemoval)
    return fail(
      framework,
      'ci-wiring',
      getNodeOptionsRemovalDiagnosis({ basicResult, evidence, framework }),
      evidence
    )
  }

  if (initializationStatus === 'not_configured') {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = ciRemediation.summary
    return fail(
      framework,
      'ci-wiring',
      `${ciScope} does not configure NODE_OPTIONS with dd-trace/ci/init, so Test Optimization is not initialized. ` +
        'This conclusion comes from the recorded CI configuration; no project CI command was run.',
      evidence
    )
  }

  if (initializationStatus === 'configured' && transport === 'agentless' && !apiKeyConfigured) {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = 'Provide DD_API_KEY from the CI secret store for the identified test job.'
    return fail(
      framework,
      'ci-wiring',
      'The identified CI test job enables agentless Test Optimization reporting but does not record DD_API_KEY as ' +
        'a required CI secret. Test data cannot be sent agentlessly without that key.',
      evidence
    )
  }

  if (initializationStatus === 'configured' && transport === 'unknown') {
    evidence.conclusion = 'confirmed_misconfigured'
    evidence.recommendation = ciRemediation.summary
    return fail(
      framework,
      'ci-wiring',
      'The identified CI test job configures Test Optimization initialization, but it neither enables agentless ' +
        'reporting nor records a Datadog Agent for the job. Configure agentless reporting with a DD_API_KEY secret ' +
        'reference, or make a Datadog Agent reachable from the test process.',
      evidence
    )
  }

  if (initializationStatus === 'configured' &&
    ((transport === 'agentless' && apiKeyConfigured) || transport === 'agent')) {
    evidence.conclusion = 'configured_propagation_unverified'
    evidence.evidenceStrength = 'inferred_static'
    evidence.recommendation = 'No CI configuration change is recommended from static evidence. Confirm the ' +
      'configuration in a real CI run if runtime propagation evidence is required.'
    return incomplete(
      framework,
      'ci-wiring',
      'The identified CI job contains the required Test Optimization initialization and reporting transport. ' +
        'Static analysis found no explicit environment reset, but it cannot prove that NODE_OPTIONS reaches the ' +
        'final test process through every wrapper. CI propagation remains unverified.',
      evidence
    )
  }

  evidence.conclusion = 'incomplete'
  evidence.evidenceStrength = initializationStatus === 'configured' ? 'inferred_static' : 'unknown'
  evidence.recommendation = initializationStatus === 'configured'
    ? ciRemediation.summary
    : 'Record whether the identified CI test job configures NODE_OPTIONS with dd-trace/ci/init and whether it uses ' +
      'agentless reporting or a reachable Datadog Agent.'
  return incomplete(
    framework,
    'ci-wiring',
    initializationStatus === 'configured'
      ? 'The CI job configures Test Optimization initialization, but the reporting transport or final-process ' +
        'propagation could not be established from static evidence.'
      : 'The CI configuration audit could not determine whether the identified test job initializes Test ' +
        'Optimization. No CI configuration conclusion was reached.',
    evidence
  )
}

/**
 * Describes the precision of the recorded CI evidence without implying a job was selected.
 *
 * @param {object} ciWiring static CI evidence
 * @returns {string} customer-facing CI scope
 */
function getCiScope (ciWiring) {
  if (ciWiring.job || ciWiring.step) return 'The identified CI test job'
  if (ciWiring.configFile) return 'The inspected CI workflow'
  return 'The inspected CI configuration'
}

/**
 * Resolves the statically recorded Test Optimization initialization state.
 *
 * @param {object} framework manifest framework entry
 * @returns {'configured'|'not_configured'|'unknown'} initialization status
 */
function getStaticInitializationStatus (framework) {
  const recorded = framework.ciWiring?.initialization?.status
  if (recorded === 'configured' || recorded === 'not_configured') return recorded
  const env = collectCiEnv(framework)
  return /(?:^|\s)(?:-r|--require)(?:=|\s+)dd-trace\/ci\/init(?:\.js)?(?:\s|$)/.test(env.NODE_OPTIONS || '')
    ? 'configured'
    : 'unknown'
}

/**
 * Reports whether CI records a secret reference for agentless reporting.
 *
 * @param {object} framework manifest framework entry
 * @returns {boolean} whether an API key reference is present
 */
function hasApiKeyReference (framework) {
  if (framework.ciWiring?.requiredSecretEnvVars?.some(name => {
    return name === 'DD_API_KEY' || name === API_KEY_ENV_ALIAS
  })) return true
  const env = collectCiEnv(framework)
  return [env.DD_API_KEY, env[API_KEY_ENV_ALIAS]]
    .some(value => typeof value === 'string' && value.length > 0)
}

/**
 * Collects non-secret CI environment evidence in effective scope order.
 *
 * @param {object} framework manifest framework entry
 * @returns {Record<string, string>} effective environment evidence
 */
function collectCiEnv (framework) {
  const ciWiring = framework.ciWiring || {}
  return {
    ...ciWiring.workflowEnv,
    ...ciWiring.jobEnv,
    ...ciWiring.stepEnv,
    ...ciWiring.inheritedEnv,
  }
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

  return `${ciCommand}${source} expands to \`${finding.command}\`. The empty \`NODE_OPTIONS=\` assignment clears ` +
    `the Datadog preload before ${frameworkName} starts.${directResult}`
}

function getNodeOptionsRemovalRecommendation (finding) {
  const source = finding.scriptName && finding.packageJson
    ? `Script \`${finding.scriptName}\` in \`${finding.packageJson}\``
    : 'The package script'
  return `${source} clears NODE_OPTIONS before the test runner starts. Remove the empty \`NODE_OPTIONS=\` ` +
    'assignment, or pass the CI-provided `-r dd-trace/ci/init` preload to the next command.'
}

function findNodeOptionsRemoval (framework, manifest) {
  for (const command of framework.ciWiring?.packageScriptExpansionChain || []) {
    if (typeof command !== 'string') continue
    if (/(?:^|\s)NODE_OPTIONS\s*=\s*(?=\s|$)/.test(command) ||
      /(?:^|\s)unset\s+NODE_OPTIONS(?:\s|$)/.test(command) ||
      /(?:^|\s)env\s+-u\s+NODE_OPTIONS(?:\s|$)/.test(command)) {
      return { command, ...findPackageScriptSource(manifest, framework, command) }
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

function summarizeBasicReportingResult (basicResult) {
  if (!basicResult) return { ran: false, reason: 'Basic Reporting was not run before the CI audit.' }
  return { ran: true, status: basicResult.status, diagnosis: basicResult.diagnosis }
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

module.exports = { runCiWiring }
