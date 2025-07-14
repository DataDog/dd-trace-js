'use strict'

const { parseModelId } = require('../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

/**
 * Get the model provider from the span tags.
 * This is normalized to LLM Observability model provider standards.
 *
 * @param {Record<string, string>} tags
 * @returns {string}
 */
function getModelProvider (tags) {
  const modelProviderTag = tags['ai.model.provider']
  const providerParts = modelProviderTag?.split('.')
  const provider = providerParts?.[0]

  if (provider === 'amazon-bedrock') {
    const modelId = tags['ai.model.id']
    const model = modelId && parseModelId(modelId)
    return model?.modelProvider ?? provider
  }

  return provider
}

module.exports = {
  getModelProvider
}
