'use strict'

// Activated rewrites publish their module name to the plugin manager after evaluation.
const registry = [
  { instrumentations: require('./instrumentations/ai') },
  { activate: true, instrumentations: require('./instrumentations/azure-cosmos') },
  { instrumentations: require('./instrumentations/azure-durable-functions') },
  { activate: true, instrumentations: require('./instrumentations/bullmq') },
  { instrumentations: require('./instrumentations/claude-agent-sdk') },
  { instrumentations: require('./instrumentations/graphql') },
  { instrumentations: require('./instrumentations/graphql-jit') },
  { activate: true, instrumentations: require('./instrumentations/langchain') },
  { activate: true, instrumentations: require('./instrumentations/langgraph') },
  { activate: true, instrumentations: require('./instrumentations/mercurius') },
  { instrumentations: require('./instrumentations/modelcontextprotocol-sdk') },
  { instrumentations: require('./instrumentations/openai-agents') },
  { instrumentations: require('./instrumentations/playwright') },
  { instrumentations: require('./instrumentations/postgres') },
  { instrumentations: require('./instrumentations/webdriverio') },
  { instrumentations: require('./instrumentations/aws-durable-execution-sdk-js') },
  { instrumentations: require('./instrumentations/supabase') },
]

const activatedModules = new Set()
for (const { activate, instrumentations } of registry) {
  if (!activate) continue
  for (const { module } of instrumentations) activatedModules.add(module.name)
}

const instrumentations = registry.flatMap(entry => entry.instrumentations)

/**
 * @param {string} moduleName
 */
function getRewriteActivationName (moduleName) {
  return activatedModules.has(moduleName) ? moduleName : undefined
}

module.exports = { getRewriteActivationName, instrumentations, registry }
