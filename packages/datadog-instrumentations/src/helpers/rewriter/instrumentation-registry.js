'use strict'

// activationName is the plugin-manager key published after a target is successfully rewritten.
const registry = [
  { instrumentations: require('./instrumentations/ai') },
  { activationName: '@azure/cosmos', instrumentations: require('./instrumentations/azure-cosmos') },
  { instrumentations: require('./instrumentations/azure-durable-functions') },
  { activationName: 'bullmq', instrumentations: require('./instrumentations/bullmq') },
  { instrumentations: require('./instrumentations/claude-agent-sdk') },
  { instrumentations: require('./instrumentations/graphql') },
  { instrumentations: require('./instrumentations/graphql-jit') },
  { activationName: '@langchain/core', instrumentations: require('./instrumentations/langchain') },
  { activationName: '@langchain/langgraph', instrumentations: require('./instrumentations/langgraph') },
  { activationName: 'mercurius', instrumentations: require('./instrumentations/mercurius') },
  { instrumentations: require('./instrumentations/modelcontextprotocol-sdk') },
  { instrumentations: require('./instrumentations/openai-agents') },
  { instrumentations: require('./instrumentations/playwright') },
  { instrumentations: require('./instrumentations/postgres') },
  { instrumentations: require('./instrumentations/react-router') },
  { instrumentations: require('./instrumentations/webdriverio') },
  { instrumentations: require('./instrumentations/aws-durable-execution-sdk-js') },
  { instrumentations: require('./instrumentations/supabase') },
]

const activationNames = new Map()
for (const { activationName, instrumentations } of registry) {
  if (!activationName) continue
  for (const { module } of instrumentations) activationNames.set(module.name, activationName)
}

const instrumentations = registry.flatMap(entry => entry.instrumentations)

/**
 * @param {string} moduleName
 */
function getRewriteActivationName (moduleName) {
  return activationNames.get(moduleName)
}

module.exports = { getRewriteActivationName, instrumentations, registry }
