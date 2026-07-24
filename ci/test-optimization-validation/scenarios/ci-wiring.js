'use strict'

const fs = require('node:fs')

const { buildCiCommandCandidate } = require('../ci-command-candidate')
const { buildCiRemediation } = require('../ci-remediation')
const { getFrameworkCiDiscoveryContradiction } = require('../ci-discovery')
const { fail, incomplete } = require('./helpers')

const MAX_CI_FILE_BYTES = 512 * 1024
const DYNAMIC_COMMAND_PATTERN = /[$`;&|\r\n]|%[^%\s]+%|![^!\s]+!/
const LITERAL_ENVIRONMENT_PREFIX =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]*)\s+)*/
const WRAPPER_PATTERN =
  /\b(?:npm|pnpm|yarn|yarnpkg)\s+(?:run\s+)?[A-Za-z0-9:_-]+\b|\bnpx(?:\.cmd)?\b|\b(?:nx|turbo|lerna|mise)\b/
const RUNNER_PATTERNS = {
  cucumber:
    /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?cucumber(?:-js)?(?:\.js)?(?:\s|$)/,
  cypress: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?cypress(?:\.js)?\s+run(?:\s|$)/,
  jest: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?jest(?:\.js)?(?:\s|$)/,
  mocha: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?mocha(?:\.js)?(?:\s|$)/,
  playwright: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?playwright(?:\.js)?\s+test(?:\s|$)/,
  vitest: /^(?:(?:[^\s]*[/\\])?node(?:\.exe)?\s+)?(?:[^\s]*[/\\])?vitest(?:\.js)?\s+run(?:\s|$)/,
}

/**
 * Audits only structurally anchored, literal CI evidence.
 *
 * @param {object} input audit inputs
 * @param {object} input.manifest validation manifest
 * @param {object} input.framework framework entry
 * @returns {object} CI audit result
 */
function runCiWiring ({ manifest, framework }) {
  const contradiction = getFrameworkCiDiscoveryContradiction(framework, manifest)
  if (contradiction) {
    return getIncomplete(framework, contradiction.reason, {
      ciDiscovery: contradiction.ciDiscovery,
      recommendation: contradiction.recommendation,
    })
  }

  const ci = framework.ciWiring || {}
  const evidence = {
    ciCommandCandidate: buildCiCommandCandidate(framework),
    conclusion: 'incomplete',
    domain: 'ci_configuration',
    evidenceStrength: 'unknown',
  }
  const missing = getMissingReviewFields(ci)
  if (missing.length > 0 || ci.unresolved?.length > 0 || ci.reviewComplete !== true) {
    return getIncomplete(
      framework,
      `The CI audit is incomplete because ${[
        ...(missing.length > 0 ? [`it is missing ${missing.join(', ')}`] : []),
        ...(ci.unresolved?.length > 0 ? [`unresolved evidence remains: ${ci.unresolved.join('; ')}`] : []),
        ...(ci.reviewComplete === true ? [] : ['the review is not marked complete']),
      ].join(' and ')}.`,
      {
        ...evidence,
        recommendation: 'Identify one exact CI test job and resolve inherited configuration and wrappers. Leave the ' +
          'result incomplete when that cannot be proven statically.',
      }
    )
  }

  const source = readCiSource(ci.configFile)
  if (!source) {
    return getIncomplete(framework, 'The recorded CI configuration file is unavailable or too large to verify.', {
      ...evidence,
      recommendation: 'Regenerate the manifest from the current checkout and review the CI file again.',
    })
  }
  if (!containsLiteral(source, ci.command) ||
    !containsLiteral(source, ci.job) ||
    (ci.step && !containsLiteral(source, ci.step))) {
    return getIncomplete(
      framework,
      'The recorded job, step, or command does not appear literally in the checksum-bound CI file.',
      {
        ...evidence,
        recommendation: 'Record the exact literal job, step, and command from the identified CI file.',
      }
    )
  }

  const command = ci.command.trim()
  const runner = getDirectRunner(command, framework.framework)
  if (DYNAMIC_COMMAND_PATTERN.test(command) || WRAPPER_PATTERN.test(command) ||
    !runner) {
    return getIncomplete(
      framework,
      'The selected CI command is dynamic or reaches the test runner through a wrapper. This validator deliberately ' +
        'does not interpret shell, package-manager, monorepo, or custom wrapper semantics.',
      {
        ...evidence,
        recommendation: 'Confirm the effective NODE_OPTIONS value in the final test-runner process with ' +
          'DD_TRACE_DEBUG=1, or record a literal direct-runner CI step.',
      }
    )
  }

  const normalizedSource = source.replaceAll('\\', '/')
  const hasInitialization = /dd-trace\/ci\/init(?:\.js)?\b/.test(normalizedSource)
  const explicitlyRemovesInitialization = commandExplicitlyClearsNodeOptions(command, framework.framework)
  const remediation = buildCiRemediation(framework)

  if (explicitlyRemovesInitialization) {
    return getFailure(
      framework,
      'The checksum-bound CI file explicitly clears NODE_OPTIONS in the selected direct test path, so ' +
        'dd-trace/ci/init cannot reach that runner.',
      {
        ...evidence,
        ciRemediation: remediation,
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: remediation.summary,
      }
    )
  }

  if (ci.initialization?.status === 'not_configured') {
    return getFailure(
      framework,
      'The reviewed selected direct-runner CI job is recorded without a dd-trace/ci/init preload. Test ' +
        'Optimization is not initialized in that job.',
      {
        ...evidence,
        ciRemediation: remediation,
        conclusion: 'confirmed_misconfigured',
        evidenceStrength: 'confirmed_static',
        recommendation: remediation.summary,
      }
    )
  }

  if (!hasInitialization || ci.initialization?.status !== 'configured') {
    return getIncomplete(
      framework,
      'Static evidence does not prove that dd-trace/ci/init is configured for the selected direct-runner job.',
      {
        ...evidence,
        recommendation: 'Record the literal NODE_OPTIONS configuration for this job or rerun the CI step with ' +
          'DD_TRACE_DEBUG=1.',
      }
    )
  }

  if (ci.transport?.mode === 'agentless' &&
    /DD_CIVISIBILITY_AGENTLESS_ENABLED/.test(source) &&
    !/\b(?:DD_API_KEY|DATADOG_API_KEY)\b/.test(source)) {
    return getIncomplete(
      framework,
      'The selected job visibly enables agentless reporting but has no Datadog API key reference in the ' +
        'checksum-bound CI file. The key may still be injected outside this file.',
      {
        ...evidence,
        ciRemediation: remediation,
        recommendation: 'Confirm that DD_API_KEY reaches this test job from the CI secret store.',
      }
    )
  }

  return getIncomplete(
    framework,
    'The selected CI job contains Test Optimization initialization, but static inspection cannot prove that the ' +
      'effective environment and reporting transport reach the final process at runtime.',
    {
      ...evidence,
      conclusion: 'configured_propagation_unverified',
      evidenceStrength: 'inferred_static',
      recommendation: 'Rerun this exact CI step with DD_TRACE_DEBUG=1 and confirm initialization in the final test ' +
        'runner.',
    }
  )
}

/**
 * Returns whether the effective inline NODE_OPTIONS assignment before a direct runner is empty.
 *
 * @param {string} command selected direct-runner command
 * @param {string} framework framework name
 * @returns {boolean} whether the final assignment clears NODE_OPTIONS
 */
function commandExplicitlyClearsNodeOptions (command, framework) {
  const runner = getDirectRunner(command, framework)
  if (!runner) return false

  const assignments = [...command.slice(0, runner.index).matchAll(
    /(?:^|\s)NODE_OPTIONS=(?:"([^"]*)"|'([^']*)'|([^\s]*))/gi
  )]
  if (assignments.length === 0) return false

  const effective = assignments.at(-1)
  return (effective[1] ?? effective[2] ?? effective[3]) === ''
}

/**
 * Locates a direct runner only at the executable position after literal environment assignments.
 *
 * @param {string} command selected CI command
 * @param {string} framework framework name
 * @returns {{index: number}|undefined} direct runner location
 */
function getDirectRunner (command, framework) {
  const prefix = LITERAL_ENVIRONMENT_PREFIX.exec(command)?.[0] || ''
  if (!RUNNER_PATTERNS[framework]?.test(command.slice(prefix.length))) return
  return { index: prefix.length }
}

/**
 * Returns missing fields required for a conclusive static audit.
 *
 * @param {object} ci CI evidence
 * @returns {string[]} missing field labels
 */
function getMissingReviewFields (ci) {
  return [
    ['CI file', ci.configFile],
    ['job', ci.job],
    ['exact command', ci.command],
  ].filter(([, value]) => typeof value !== 'string' || !value.trim()).map(([label]) => label)
}

/**
 * Reads one bounded regular CI file.
 *
 * @param {string} filename CI file
 * @returns {string|undefined} source
 */
function readCiSource (filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CI_FILE_BYTES) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

/**
 * Checks whether recorded text appears literally after line-ending normalization.
 *
 * @param {string} source file source
 * @param {string} value recorded value
 * @returns {boolean} literal presence
 */
function containsLiteral (source, value) {
  const normalizedSource = source.replaceAll('\r\n', '\n')
  const normalizedValue = String(value).replaceAll('\r\n', '\n').trim()
  return normalizedValue !== '' && normalizedSource.includes(normalizedValue)
}

/**
 * Builds an incomplete CI result.
 *
 * @param {object} framework framework entry
 * @param {string} diagnosis diagnosis
 * @param {object} evidence evidence
 * @returns {object} result
 */
function getIncomplete (framework, diagnosis, evidence) {
  return incomplete(framework, 'ci-wiring', diagnosis, {
    ciWiring: framework.ciWiring,
    ...evidence,
  })
}

/**
 * Builds a confirmed CI failure.
 *
 * @param {object} framework framework entry
 * @param {string} diagnosis diagnosis
 * @param {object} evidence evidence
 * @returns {object} result
 */
function getFailure (framework, diagnosis, evidence) {
  return fail(framework, 'ci-wiring', diagnosis, {
    ciWiring: framework.ciWiring,
    ...evidence,
  })
}

module.exports = { runCiWiring }
