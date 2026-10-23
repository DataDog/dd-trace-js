'use strict'

// Activated rewrites publish their module name to the plugin manager after evaluation.
// Integrations can also provide synchronous runtime setup before plugin activation.
// Setup must not load rewrite targets: re-entrant activations of the same group are dropped.
// activate: true covers every rewrite target in the entry; activate.modules narrows it to the packages
// that should trigger activation, leaving the rest of the entry rewrite-only.
// Other entries use hooks or another activation path, or do not need activation from a rewrite.
/**
 * @typedef {object} Activation
 * @property {string} moduleName
 * @property {string} [version]
 *
 * @typedef {object} ActivationConfig
 * @property {string[]} [modules]
 * @property {((activation: Activation) => void)} [setup]
 *
 * @typedef {object} InstrumentationRegistryEntry
 * @property {true|ActivationConfig} [activate]
 * @property {Array<{ module: { name: string } }>} instrumentations
 */

/** @satisfies {InstrumentationRegistryEntry[]} */
const registry = [
  { instrumentations: require('./instrumentations/ai') },
  { activate: true, instrumentations: require('./instrumentations/azure-cosmos') },
  { instrumentations: require('./instrumentations/azure-durable-functions') },
  { activate: true, instrumentations: require('./instrumentations/bullmq') },
  {
    activate: { setup: () => require('../../claude-agent-sdk') },
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
    activate: { setup: () => require('../../aws-durable-execution-sdk-js') },
    instrumentations: require('./instrumentations/aws-durable-execution-sdk-js'),
  },
  { activate: true, instrumentations: require('./instrumentations/supabase') },
]

const activatedModules = new Set()
/** @type {Map<string, (activation: Activation) => void>} */
const activationSetups = new Map()
for (const { activate, instrumentations } of registry) {
  if (activate === undefined) continue
  if (activate !== true && (typeof activate !== 'object' || activate === null || Array.isArray(activate))) {
    throw new TypeError('Instrumentation registry activate must be true or an activation config object')
  }
  const config = activate === true ? undefined : activate
  const setup = config?.setup
  if (setup !== undefined && typeof setup !== 'function') {
    throw new TypeError('Instrumentation registry activate.setup must be a function')
  }

  const rewriteModules = new Set(instrumentations.map(({ module }) => module.name))
  for (const moduleName of resolveActivationModules(config?.modules, rewriteModules)) {
    if (activatedModules.has(moduleName) && activationSetups.get(moduleName) !== setup) {
      throw new TypeError(`Instrumentation registry activation module "${moduleName}" has conflicting setup functions`)
    }
    activatedModules.add(moduleName)
    if (setup) activationSetups.set(moduleName, setup)
  }
}

/**
 * Activation covers every rewrite target in the entry unless it names the packages to activate. An explicit
 * list keeps helper packages that share the entry rewrite-only.
 * @param {string[]|undefined} modules
 * @param {Set<string>} rewriteModules
 * @returns {Set<string>}
 */
function resolveActivationModules (modules, rewriteModules) {
  if (modules === undefined) return rewriteModules
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError('Instrumentation registry activate.modules must be a non-empty array')
  }

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
    entryModules.add(moduleName)
  }
  return entryModules
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
