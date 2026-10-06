'use strict'

// Activated rewrites publish their module name to the plugin manager after evaluation.
// Integrations can also provide synchronous runtime setup before plugin activation.
// Other entries use hooks or another activation path, or do not need activation from a rewrite.
/**
 * @typedef {object} Activation
 * @property {string} moduleName
 * @property {string} [version]
 *
 * @typedef {object} InstrumentationRegistryEntry
 * @property {boolean|((activation: Activation) => void)} [activate]
 * @property {Array<{ module: { name: string } }>} instrumentations
 */

/** @satisfies {InstrumentationRegistryEntry[]} */
const registry = [
  { activate: () => require('../../ai'), instrumentations: require('./instrumentations/ai') },
  { activate: true, instrumentations: require('./instrumentations/azure-cosmos') },
  { instrumentations: require('./instrumentations/azure-durable-functions') },
  { activate: true, instrumentations: require('./instrumentations/bullmq') },
  {
    activate: () => require('../../claude-agent-sdk'),
    instrumentations: require('./instrumentations/claude-agent-sdk'),
  },
  { instrumentations: require('./instrumentations/graphql') },
  { instrumentations: require('./instrumentations/graphql-jit') },
  { activate: true, instrumentations: require('./instrumentations/langchain') },
  { activate: true, instrumentations: require('./instrumentations/langgraph') },
  { activate: true, instrumentations: require('./instrumentations/mercurius') },
  { instrumentations: require('./instrumentations/modelcontextprotocol-sdk') },
  { instrumentations: require('./instrumentations/openai-agents') },
  { instrumentations: require('./instrumentations/playwright') },
  { activate: true, instrumentations: require('./instrumentations/postgres') },
  { instrumentations: require('./instrumentations/webdriverio') },
  {
    activate: () => require('../../aws-durable-execution-sdk-js'),
    instrumentations: require('./instrumentations/aws-durable-execution-sdk-js'),
  },
  { activate: true, instrumentations: require('./instrumentations/supabase') },
]

const activatedModules = new Set()
/** @type {Map<string, (activation: Activation) => void>} */
const activationSetups = new Map()
for (const { activate, instrumentations } of registry) {
  if (activate !== undefined && typeof activate !== 'boolean' && typeof activate !== 'function') {
    throw new TypeError('Instrumentation registry activate must be a boolean or a function')
  }
  if (!activate) continue
  for (const { module } of instrumentations) {
    activatedModules.add(module.name)
    if (typeof activate === 'function') activationSetups.set(module.name, activate)
  }
}

const instrumentations = registry.flatMap(entry => entry.instrumentations)

/**
 * @param {string} moduleName
 */
function isRewriteActivationEnabled (moduleName) {
  return activatedModules.has(moduleName)
}

/**
 * @param {string} moduleName
 * @returns {((activation: Activation) => void)|undefined}
 */
function getActivationSetup (moduleName) {
  return activationSetups.get(moduleName)
}

module.exports = { getActivationSetup, isRewriteActivationEnabled, instrumentations, registry }
