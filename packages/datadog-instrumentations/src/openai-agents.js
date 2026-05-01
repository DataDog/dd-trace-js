'use strict'

const { getIntegration, onIntegrationReady } = require(
  '../../datadog-plugin-openai-agents/src/registry'
)
const { DDOpenAIAgentsProcessor } = require(
  '../../datadog-plugin-openai-agents/src/processor'
)
const { addHook, getHooks } = require('./helpers/instrument')

// Orchestrion entries still need their noop require-hook so the rewriter's
// tracing channels get exercised. The new data path is the TracingProcessor
// registered below; the remaining orchestrion entries cover only the Python
// supplement for per-turn agent-manifest tagging (AgentRunner._runSingleTurn).
for (const hook of getHooks(['@openai/agents-core', '@openai/agents-openai'])) {
  addHook(hook, exports => exports)
}

/**
 * @param {object} mod `@openai/agents-core` module exports.
 * @returns {object} the same module exports, possibly with our processor registered.
 */
function registerProcessor (mod) {
  if (mod?._datadogPatched) return mod
  if (typeof mod?.addTraceProcessor !== 'function') return mod

  const apply = (integration) => {
    if (mod._datadogPatched) return
    mod._datadogPatched = true
    mod.addTraceProcessor(new DDOpenAIAgentsProcessor(integration))
  }

  if (getIntegration()) {
    apply(getIntegration())
  } else {
    // Plugin hasn't configured yet — register lazily.
    onIntegrationReady(apply)
  }

  return mod
}

addHook({ name: '@openai/agents-core', versions: ['>=0.7.0'] }, registerProcessor)
