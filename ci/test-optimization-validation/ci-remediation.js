'use strict'

const path = require('node:path')

const { findEnvironmentEntry } = require('./environment')
const { splitNodeOptions } = require('./executable')
const { removeEmptyLiteralEnvironmentAssignments } = require('./literal-environment')

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
  const variants = getVariants(transport, ciWiring, recommendedValues, nodeOptions)

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
  const mode = framework.ciWiring?.transport?.mode
  return ['agentless', 'agent', 'none'].includes(mode) ? mode : 'unknown'
}

function getCiLocation (ciWiring) {
  let location = ''
  if (ciWiring.configFile) location += `configuration ${formatPath(ciWiring.configFile)}`
  if (ciWiring.workflow) location += `${location ? ', ' : ''}workflow ${JSON.stringify(String(ciWiring.workflow))}`
  if (ciWiring.job) location += `${location ? ', ' : ''}job ${JSON.stringify(String(ciWiring.job))}`
  if (ciWiring.step) location += `${location ? ', ' : ''}step ${JSON.stringify(String(ciWiring.step))}`
  return location || 'the selected CI test step'
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

function getVariants (transport, ciWiring, recommendedValues, nodeOptions) {
  if (transport === 'agent') return [getVariant('agent', ciWiring, recommendedValues, nodeOptions)]
  return [getVariant('agentless', ciWiring, recommendedValues, nodeOptions)]
}

function getVariant (transport, ciWiring, recommendedValues, nodeOptions) {
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
    snippet: formatSnippet({ ...requiredEnv, ...recommendedEnv }, ciWiring),
  }
}

function getNodeOptions (framework) {
  const existing = getEffectiveNodeOptions(framework.ciWiring)
  const options = existing ? [existing] : []
  if (framework.framework === 'vitest' &&
    !hasNodeModuleOption(existing, ['--import'], isDatadogRegisterSpecifier)) {
    options.push('--import dd-trace/register.js')
  }
  if (!hasNodeModuleOption(existing, ['-r', '--require'], isDatadogCiInitSpecifier)) {
    options.push('-r dd-trace/ci/init')
  }
  return options.join(' ')
}

function getEffectiveNodeOptions (ciWiring = {}) {
  const platform = getCiPlatform(ciWiring)
  let value
  for (const field of ['inheritedEnv', 'workflowEnv', 'jobEnv', 'stepEnv']) {
    const entry = findEnvironmentEntry(ciWiring[field], 'NODE_OPTIONS', platform)
    if (entry) value = entry[1]
  }
  if (typeof value !== 'string') return ''
  const literal = value.trim()
  return hasDynamicEnvironmentReference(literal) ? '' : literal
}

function hasNodeModuleOption (value, optionNames, matchesSpecifier) {
  if (!value) return false
  let args
  try {
    args = splitNodeOptions(value)
  } catch {
    return false
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    let specifier
    if (optionNames.includes(argument)) {
      specifier = args[++index]
    } else {
      for (const optionName of optionNames) {
        const prefix = `${optionName}=`
        if (argument.startsWith(prefix)) specifier = argument.slice(prefix.length)
      }
    }
    if (matchesSpecifier(specifier)) return true
  }
  return false
}

function isDatadogCiInitSpecifier (specifier) {
  return isDatadogModuleSpecifier(specifier, 'ci/init')
}

function isDatadogRegisterSpecifier (specifier) {
  return isDatadogModuleSpecifier(specifier, 'register')
}

function isDatadogModuleSpecifier (specifier, entrypoint) {
  if (typeof specifier !== 'string') return false
  const normalized = specifier.replaceAll('\\', '/')
  return [`dd-trace/${entrypoint}`, `dd-trace/${entrypoint}.js`].some(candidate => {
    return normalized === candidate || normalized.endsWith(`/${candidate}`)
  })
}

function hasDynamicEnvironmentReference (value) {
  return /\$[A-Za-z_{]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/.test(value)
}

function getRecommendedValues (framework) {
  const projectName = normalizeName(framework.project?.name || framework.id || 'test')
  const context = [
    framework.ciWiring?.step,
    framework.ciWiring?.job,
    framework.ciWiring?.command,
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

function formatSnippet (env, ciWiring) {
  if (ciWiring.provider === 'github-actions') {
    const testCommand = getTestCommand(ciWiring)
    const lines = [
      ciWiring.configFile ? `# ${formatPath(ciWiring.configFile)}` : '# GitHub Actions workflow',
      ciWiring.job ? `# Job: ${ciWiring.job}` : '# Selected test job',
    ]
    if (!testCommand) {
      return [
        ...lines,
        'env:',
        ...Object.entries(env).map(([name, value]) => `  ${name}: ${quoteYamlValue(value)}`),
      ].join('\n')
    }
    return [
      ...lines,
      `- name: ${quoteYamlValue(ciWiring.step || 'Run tests with Datadog')}`,
      '  env:',
      ...Object.entries(env).map(([name, value]) => `    ${name}: ${quoteYamlValue(value)}`),
      '  run: |',
      ...testCommand.split(/\r?\n/).map(line => `    ${line}`),
    ].join('\n')
  }

  return Object.entries(env).map(([name, value]) => {
    const safeValue = name === 'DD_API_KEY' ? '<DD_API_KEY_FROM_CI_SECRET_STORE>' : value
    return `${name}=${quoteShellValue(safeValue)}`
  }).join('\n')
}

function quoteShellValue (value) {
  return JSON.stringify(String(value))
}

function getTestCommand (ciWiring) {
  if (typeof ciWiring.command === 'string' && ciWiring.command.trim()) {
    return removeEmptyLiteralEnvironmentAssignments(
      ciWiring.command,
      'NODE_OPTIONS',
      getCiPlatform(ciWiring)
    )
  }
  return ciWiring.packageScriptExpansionChain?.[0] || ciWiring.runnerToolChain?.[0]
}

function getCiPlatform (ciWiring) {
  const shellName = path.basename(String(ciWiring.shell || '')).toLowerCase()
  return ['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(shellName)
    ? 'win32'
    : process.platform
}

function quoteYamlValue (value) {
  if (String(value).startsWith('${{')) return value
  return JSON.stringify(String(value))
}

module.exports = {
  buildCiRemediation,
  getConfiguredTransport,
}
