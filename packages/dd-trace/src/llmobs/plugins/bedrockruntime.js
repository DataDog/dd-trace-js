const BaseLLMObsPlugin = require('./base')
const { storage } = require('../../../../datadog-core')
const llmobsStore = storage('llmobs')

const get = require('../../../../datadog-core/src/utils/src/get')

const {
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId,
  PROVIDER
} = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

const enabledOperations = ['invokeModel']

const requestIdsToTokens = {}

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', ({ response }) => {
      const request = response.request
      const operation = request.operation
      // avoids instrumenting other non supported runtime operations
      if (!enabledOperations.includes(operation)) {
        return
      }
      const { modelProvider, modelName } = parseModelId(request.params.modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) {
        return
      }
      const span = storage.getStore()?.span
      this.setLLMObsTags({ request, span, response, modelProvider, modelName })
    })

    this.addSub('apm:aws:headers:bedrockruntime', ({ headers }) => {
      const requestId = headers['x-amzn-requestid']
      const inputTokenCount = headers['x-amzn-bedrock-input-token-count']
      const outputTokenCount = headers['x-amzn-bedrock-output-token-count']

      requestIdsToTokens[requestId] = {
        inputTokenCount,
        outputTokenCount
      }
    })
  }

  setLLMObsTags ({ request, span, response, modelProvider, modelName }) {
    const parent = llmobsStore.getStore()?.span
    this._tagger.registerLLMObsSpan(span, {
      parent,
      modelName: modelName.toLowerCase(),
      modelProvider: modelProvider.toLowerCase(),
      kind: 'llm',
      name: 'bedrock-runtime.command'
    })

    const requestParams = extractRequestParams(request.params, modelProvider)
    const textAndResponseReason = extractTextAndResponseReason(response, modelProvider, modelName)

    // add metadata tags
    this._tagger.tagMetadata(span, {
      temperature: parseFloat(requestParams.temperature) || 0.0,
      max_tokens: parseInt(requestParams.maxTokens) || 0
    })

    // add I/O tags
    this._tagger.tagLLMIO(
      span,
      requestParams.prompt,
      [{ content: textAndResponseReason.message, role: textAndResponseReason.role }]
    )

    // add token metrics
    const { inputTokens, outputTokens, totalTokens } = extractTokens(response, modelProvider)
    this._tagger.tagMetrics(span, {
      inputTokens,
      outputTokens,
      totalTokens
    })
  }
}

function extractTokens (response, provider) {
  const requestId = response.$metadata.requestId
  const { inputTokenCount, outputTokenCount } = requestIdsToTokens[requestId] || {}
  delete requestIdsToTokens[requestId]

  const tokensBasedOnProvider = findTokensByProvider(response, provider)

  const inputTokens = (
    tokensBasedOnProvider != null ? tokensBasedOnProvider.inputTokens : parseInt(inputTokenCount)
  ) || 0

  const outputTokens = (
    tokensBasedOnProvider != null ? tokensBasedOnProvider.outputTokens : parseInt(outputTokenCount)
  ) || 0

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  }
}

const TOKEN_PATHS = {
  [PROVIDER.AMAZON]: {
    inputTokens: 'inputTextTokenCount',
    outputTokens: 'results.0.tokenCount'
  },
  [PROVIDER.AI21]: {
    inputTokens: 'usage.prompt_tokens',
    outputTokens: 'usage.completion_tokens'
  },
  [PROVIDER.META]: {
    inputTokens: 'prompt_token_count',
    outputTokens: 'generation_token_count'
  }
}

// Try and use the provider token paths in the case that
// we didn't extract them from the headers
function findTokensByProvider (response, provider) {
  const tokenPaths = TOKEN_PATHS[provider.toUpperCase()]
  if (!tokenPaths) {
    return null
  }

  const body = JSON.parse(Buffer.from(response.body).toString('utf8'))

  const inputTokens = get(body, tokenPaths.inputTokens) ?? 0
  const outputTokens = get(body, tokenPaths.outputTokens) ?? 0

  return {
    inputTokens,
    outputTokens
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
