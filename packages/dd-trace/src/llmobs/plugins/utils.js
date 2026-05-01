'use strict'

/**
 * Maps an OpenAI-compatible base URL to a model provider string.
 * Covers OpenAI, Azure OpenAI, and DeepSeek; falls back to 'unknown'
 * for any unrecognised host (e.g. local proxies or custom deployments).
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function getOpenAIModelProvider (baseUrl = '') {
  if (baseUrl.includes('azure')) return 'azure_openai'
  if (baseUrl.includes('deepseek')) return 'deepseek'
  if (baseUrl.includes('openai')) return 'openai'
  return 'unknown'
}

module.exports = { getOpenAIModelProvider }
