'use strict'

const { getIntegration } = require('../../datadog-plugin-openai-agents/src')
const { DDOpenAIAgentsProcessor } = require(
  '../../datadog-plugin-openai-agents/src/processor'
)
const { addHook } = require('./helpers/instrument')

/**
 * @param {object} mod `@openai/agents-core` module exports.
 * @returns {object} the same module exports, possibly with our processor registered.
 */
function registerProcessor (mod) {
  if (mod?._datadogPatched) return mod
  if (typeof mod?.addTraceProcessor !== 'function') return mod

  const integration = getIntegration()
  if (!integration) return mod

  mod._datadogPatched = true
  mod.addTraceProcessor(new DDOpenAIAgentsProcessor(integration))
  return mod
}

addHook({ name: '@openai/agents-core', versions: ['>=0.7.0'] }, registerProcessor)
