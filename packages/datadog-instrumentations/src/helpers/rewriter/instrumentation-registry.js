'use strict'

// Activated rewrites publish their module name to the plugin manager after evaluation.
// Integrations can also provide synchronous runtime setup before plugin activation.
// Setup must not load rewrite targets: re-entrant activations of the same group are dropped.
// Rewrite descriptors never implicitly opt another package into activation.
// Other entries use hooks or another activation path, or do not need activation from a rewrite.
/**
 * @typedef {object} Activation
 * @property {string} moduleName
 * @property {string} [version]
 *
 * @typedef {object} ActivationConfig
 * @property {string[]} modules
 * @property {((activation: Activation) => void)} [setup]
 *
 * @typedef {object} InstrumentationRegistryEntry
 * @property {ActivationConfig} [activate]
 * @property {Array<{ module: { name: string, versionRange: string, filePath: string },
 *   [key: string]: unknown }>} instrumentations
 */

/** @type {InstrumentationRegistryEntry[]} */
const registry = [
  { instrumentations: require('./instrumentations/ai') },
  { activate: { modules: ['@azure/cosmos'] }, instrumentations: require('./instrumentations/azure-cosmos') },
  { instrumentations: require('./instrumentations/azure-durable-functions') },
  { activate: { modules: ['bullmq'] }, instrumentations: require('./instrumentations/bullmq') },
  {
    activate: { modules: ['@anthropic-ai/claude-agent-sdk'], setup: () => require('../../claude-agent-sdk') },
    instrumentations: require('./instrumentations/claude-agent-sdk'),
  },
  { instrumentations: require('./instrumentations/graphql') },
  { instrumentations: require('./instrumentations/graphql-jit') },
  { activate: { modules: ['@langchain/core'] }, instrumentations: require('./instrumentations/langchain') },
  { activate: { modules: ['@langchain/langgraph'] }, instrumentations: require('./instrumentations/langgraph') },
  { activate: { modules: ['mercurius'] }, instrumentations: require('./instrumentations/mercurius') },
  { instrumentations: require('./instrumentations/modelcontextprotocol-sdk') },
  { instrumentations: require('./instrumentations/openai-agents') },
  { instrumentations: require('./instrumentations/playwright') },
  { activate: { modules: ['postgres'] }, instrumentations: require('./instrumentations/postgres') },
  { instrumentations: require('./instrumentations/webdriverio') },
  { instrumentations: require('./instrumentations/aws-durable-execution-sdk-js') },
  {
    activate: {
      modules: [
        '@supabase/auth-js',
        '@supabase/functions-js',
        '@supabase/postgrest-js',
        '@supabase/realtime-js',
        '@supabase/storage-js',
      ],
    },
    instrumentations: require('./instrumentations/supabase'),
  },
]

const activatedModules = new Set()
/** @type {Map<string, (activation: Activation) => void>} */
const activationSetups = new Map()
for (const { activate, instrumentations } of registry) {
  if (activate === undefined) continue
  if (typeof activate !== 'object' || activate === null || Array.isArray(activate)) {
    throw new TypeError('Instrumentation registry activate must be an object')
  }
  const { modules, setup } = activate
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError('Instrumentation registry activate.modules must be a non-empty array')
  }
  if (setup !== undefined && typeof setup !== 'function') {
    throw new TypeError('Instrumentation registry activate.setup must be a function')
  }

  const rewriteModules = new Set(instrumentations.map(({ module }) => module.name))
  const entryModules = new Set()
  for (const moduleName of modules) {
    if (typeof moduleName !== 'string' || moduleName.length === 0) {
      throw new TypeError('Instrumentation registry activate.modules must contain non-empty strings')
    }
    if (!rewriteModules.has(moduleName)) {
      throw new TypeError(
        `Instrumentation registry activation module "${moduleName}" is not a rewrite target in its entry`
      )
    }
    if (entryModules.has(moduleName)) {
      throw new TypeError(`Instrumentation registry activation module "${moduleName}" is duplicated in its entry`)
    }
    if (activatedModules.has(moduleName) && activationSetups.get(moduleName) !== setup) {
      throw new TypeError(`Instrumentation registry activation module "${moduleName}" has conflicting setup functions`)
    }
    entryModules.add(moduleName)
    activatedModules.add(moduleName)
    if (setup) activationSetups.set(moduleName, setup)
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
