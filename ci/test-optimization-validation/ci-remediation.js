'use strict'

const path = require('node:path')

const { serializeDisplayCommand } = require('./command-runner')

const GITHUB_API_KEY_REFERENCE = '$' + '{{ secrets.DD_API_KEY }}'
const AGENTLESS_ENV = {
  DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true',
  DD_API_KEY: GITHUB_API_KEY_REFERENCE,
}
const OPTIONAL_VALUES = {
  agent: [],
  agentless: [
    {
      name: 'DD_SITE',
      description: 'Set when the Datadog account does not use the default datadoghq.com site.',
    },
  ],
}

/**
 * Builds a customer-facing CI configuration fix without including real credentials.
 *
 * @param {object} framework normalized framework manifest entry
 * @returns {object} structured remediation
 */
function buildCiRemediation (framework) {
  const ciWiring = framework.ciWiring || {}
  const transport = getConfiguredTransport(framework)
  const location = getCiLocation(ciWiring)
  const nodeOptions = getNodeOptions(framework)
  const recommendedValues = getRecommendedValues(framework)
  const variants = getVariants(transport, ciWiring, framework.ciWiringCommand, recommendedValues, nodeOptions)

  return {
    provider: ciWiring.provider || 'unknown',
    configFile: ciWiring.configFile,
    workflow: ciWiring.workflow,
    job: ciWiring.job,
    step: ciWiring.step,
    location,
    transport,
    summary: getSummary({ location, transport, recommendedValues, nodeOptions }),
    variants,
  }
}

function getConfiguredTransport (framework) {
  const env = collectCiEnv(framework)
  if (isTrue(env.DD_CIVISIBILITY_AGENTLESS_ENABLED) || env.DD_API_KEY) return 'agentless'
  if (env.DD_AGENT_HOST || env.DD_TRACE_AGENT_URL || env.DD_TRACE_AGENT_HOSTNAME) return 'agent'
  return 'unknown'
}

function collectCiEnv (framework) {
  const ciWiring = framework.ciWiring || {}
  return {
    ...ciWiring.workflowEnv,
    ...ciWiring.jobEnv,
    ...ciWiring.stepEnv,
    ...ciWiring.inheritedEnv,
    ...framework.ciWiringCommand?.env,
  }
}

function isTrue (value) {
  return ['1', 'true'].includes(String(value || '').toLowerCase())
}

function getCiLocation (ciWiring) {
  const parts = []
  if (ciWiring.configFile) parts.push(`configuration ${formatPath(ciWiring.configFile)}`)
  if (ciWiring.workflow) parts.push(`workflow ${JSON.stringify(String(ciWiring.workflow))}`)
  if (ciWiring.job) parts.push(`job ${JSON.stringify(String(ciWiring.job))}`)
  if (ciWiring.step) parts.push(`step ${JSON.stringify(String(ciWiring.step))}`)
  return parts.length > 0 ? parts.join(', ') : 'the selected CI test step'
}

function formatPath (filename) {
  const value = String(filename)
  const cwd = process.cwd()
  const relative = path.relative(cwd, value)
  return JSON.stringify(relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value)
}

function getSummary ({ location, transport, recommendedValues, nodeOptions }) {
  const recommended = recommendedValues.map(({ name, value }) => `${name}=${value}`).join(' and ')
  if (transport === 'agentless') {
    return `In ${location}, set NODE_OPTIONS=${nodeOptions}, keep ` +
      `DD_CIVISIBILITY_AGENTLESS_ENABLED=true, provide DD_API_KEY from the CI secret store, and set ${recommended}. ` +
      getAgentAlternative()
  }
  if (transport === 'agent') {
    return `In ${location}, set NODE_OPTIONS=${nodeOptions} and set ${recommended}. A Datadog Agent is ` +
      'already configured; when it is reachable by the test process, do not pass DD_API_KEY or ' +
      'DD_CIVISIBILITY_AGENTLESS_ENABLED.'
  }
  return `In ${location}, set NODE_OPTIONS=${nodeOptions}, ` +
    `DD_CIVISIBILITY_AGENTLESS_ENABLED=true, provide DD_API_KEY from the CI secret store, and set ${recommended}. ` +
    getAgentAlternative()
}

function getAgentAlternative () {
  return 'If a Datadog Agent is available and reachable by the test process, do not pass DD_API_KEY or ' +
    'DD_CIVISIBILITY_AGENTLESS_ENABLED.'
}

function getVariants (transport, ciWiring, command, recommendedValues, nodeOptions) {
  if (transport === 'agent') return [getVariant('agent', ciWiring, command, recommendedValues, nodeOptions)]
  return [getVariant('agentless', ciWiring, command, recommendedValues, nodeOptions)]
}

function getVariant (transport, ciWiring, command, recommendedValues, nodeOptions) {
  const transportEnv = transport === 'agentless' ? AGENTLESS_ENV : {}
  const requiredEnv = { NODE_OPTIONS: nodeOptions, ...transportEnv }
  const recommendedEnv = Object.fromEntries(recommendedValues.map(({ name, value }) => [name, value]))
  return {
    id: transport,
    name: transport === 'agentless' ? 'Agentless reporting' : 'Datadog Agent available to the CI job',
    prerequisite: transport === 'agentless'
      ? 'Store the Datadog API key in the CI provider secret store.'
      : 'A Datadog Agent must be reachable from the CI test job.',
    requiredValues: Object.entries(requiredEnv).map(([name, value]) => ({
      name,
      value,
      source: name === 'DD_API_KEY' ? 'ci-secret-store' : 'literal',
    })),
    recommendedValues,
    optionalValues: OPTIONAL_VALUES[transport],
    snippet: formatSnippet({ ...requiredEnv, ...recommendedEnv }, ciWiring, command),
  }
}

function getNodeOptions (framework) {
  if (framework.framework === 'vitest') return '--import dd-trace/register.js -r dd-trace/ci/init'
  return '-r dd-trace/ci/init'
}

function getRecommendedValues (framework) {
  const projectName = normalizeName(framework.project?.name || framework.id || 'test')
  const context = [
    framework.ciWiring?.step,
    framework.ciWiring?.job,
    framework.existingTestCommand?.description,
    framework.ciWiringCommand?.description,
  ].filter(Boolean).join(' ')
  const testKind = /\bunit\b/i.test(context)
    ? 'unit-tests'
    : /\bintegration\b/i.test(context) ? 'integration-tests' : 'tests'
  const frameworkName = normalizeName(framework.framework || 'test')

  return [
    {
      name: 'DD_SERVICE',
      value: `${projectName}-tests`,
      description: 'Use a service name that identifies this project test suite.',
    },
    {
      name: 'DD_TEST_SESSION_NAME',
      value: `${frameworkName}-${testKind}`,
      description: 'Use a session name that identifies this test runner and suite.',
    },
  ]
}

function normalizeName (value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/^@/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '') || 'test'
}

function formatSnippet (env, ciWiring, command) {
  if (ciWiring.provider === 'github-actions') {
    const testCommand = getTestCommand(ciWiring, command)
    return [
      ciWiring.configFile ? `# ${formatPath(ciWiring.configFile)}` : '# GitHub Actions workflow',
      ciWiring.job ? `# Job: ${ciWiring.job}` : '# Selected test job',
      `- name: ${quoteYamlValue(ciWiring.step || 'Run tests with Datadog')}`,
      '  env:',
      ...Object.entries(env).map(([name, value]) => `    ${name}: ${quoteYamlValue(value)}`),
      '  run: |',
      ...String(testCommand).split(/\r?\n/).map(line => `    ${line}`),
    ].join('\n')
  }

  return Object.entries(env).map(([name, value]) => {
    return `${name}=${name === 'DD_API_KEY' ? '<DD_API_KEY_FROM_CI_SECRET_STORE>' : value}`
  }).join('\n')
}

function getTestCommand (ciWiring, command) {
  if (command) return serializeDisplayCommand(command)
  return ciWiring.packageScriptExpansionChain?.[0] || ciWiring.runnerToolChain?.[0] ||
    '# keep the existing test command here'
}

function quoteYamlValue (value) {
  if (String(value).startsWith('${{')) return value
  return JSON.stringify(String(value))
}

module.exports = { buildCiRemediation }
