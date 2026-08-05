'use strict'

const { parseModelId: parseBedrockModelId } = require('../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

/**
 * Get the model provider from the span tags or attributes.
 * This is normalized to LLM Observability model provider standards.
 *
 * @param {Record<string, string>} tags
 * @returns {string}
 */
function getModelProvider (tags) {
  const modelProviderTag = tags['ai.model.provider']
  const modelId = tags['ai.model.id']

  return parseModelProvider(modelProviderTag, modelId)
}

/**
 * Parse the model provider from the raw provider string.
 *
 * @param {string} rawProvider
 * @param {string} modelId
 * @returns {string}
 */
function parseModelProvider (rawProvider, modelId) {
  const providerParts = rawProvider?.split('.')
  const provider = providerParts?.[0]

  if (provider === 'amazon-bedrock') {
    const model = modelId && parseBedrockModelId(modelId)
    return model?.modelProvider ?? provider
  }

  return provider
}

module.exports = {
  getModelProvider,
  parseModelProvider,
}
