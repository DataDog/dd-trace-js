'use strict'

const { getIntegration } = require('../../datadog-plugin-openai-agents/src')
const { DDOpenAIAgentsProcessor } = require(
  '../../datadog-plugin-openai-agents/src/processor'
)
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

/**
 * @param {object} mod `@openai/agents-core` module exports.
 * @returns {object} the same module exports, possibly with our processor registered.
 */
function registerProcessor (mod) {
  if (mod?._datadogPatched) return mod
  if (typeof mod?.addTraceProcessor !== 'function') return mod

  // Bind the lazy accessor so the processor follows plugin re-instantiation
  // even though agents-core keeps the processor registration for the life
  // of the module.
  mod._datadogPatched = true
  mod.addTraceProcessor(new DDOpenAIAgentsProcessor(getIntegration))
  return mod
}

addHook({ name: '@openai/agents-core', versions: ['>=0.7.0'] }, registerProcessor)

/**
 * Capture the OpenAI client's baseURL on each `getResponse` / `getStreamedResponse`
 * call so the integration can tag `model_provider` (openai / azure_openai /
 * deepseek / unknown). Last-write-wins; single-provider-per-process is the
 * assumed deployment shape — matches dd-trace-py's openai-agents integration.
 *
 * @param {Function} original
 * @returns {Function}
 */
function wrapResponseMethod (original) {
  return function (...args) {
    const integration = getIntegration()
    const baseURL = this?.client?.baseURL
    if (integration?.enabled && baseURL) {
      integration.setClientBaseURL(baseURL)
    }
    return original.apply(this, args)
  }
}

addHook({ name: '@openai/agents-openai', versions: ['>=0.7.0'] }, (mod) => {
  if (mod?._datadogPatched) return mod
  const proto = mod?.OpenAIResponsesModel?.prototype
  if (!proto) return mod

  mod._datadogPatched = true
  shimmer.wrap(proto, 'getResponse', wrapResponseMethod)
  shimmer.wrap(proto, 'getStreamedResponse', wrapResponseMethod)
  return mod
})
