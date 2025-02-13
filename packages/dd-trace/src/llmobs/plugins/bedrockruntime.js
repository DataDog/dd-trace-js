const BaseLLMObsPlugin = require('./base')
const { storage } = require('../../../../datadog-core')
const llmobsStore = storage('llmobs')

const {
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId
} = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

const ENABLED_OPERATIONS = ['invokeModel']

const requestIdsToTokens = {}

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', ({ response }) => {
      const request = response.request
      const operation = request.operation
      // avoids instrumenting other non supported runtime operations
      if (!ENABLED_OPERATIONS.includes(operation)) {
        return
      }
      const { modelProvider, modelName } = parseModelId(request.params.modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) {
        return
      }
      const span = storage('legacy').getStore()?.span
      this.setLLMObsTags({ request, span, response, modelProvider, modelName })
    })

    this.addSub('apm:aws:response:deserialize:bedrockruntime', ({ headers }) => {
      const requestId = headers['x-amzn-requestid']
      const inputTokenCount = headers['x-amzn-bedrock-input-token-count']
      const outputTokenCount = headers['x-amzn-bedrock-output-token-count']

      requestIdsToTokens[requestId] = {
        inputTokensFromHeaders: inputTokenCount && parseInt(inputTokenCount),
        outputTokensFromHeaders: outputTokenCount && parseInt(outputTokenCount)
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
    const { inputTokens, outputTokens, totalTokens } = extractTokens({
      requestId: response.$metadata.requestId,
      usage: textAndResponseReason.usage
    })
    this._tagger.tagMetrics(span, {
      inputTokens,
      outputTokens,
      totalTokens
    })
  }
}

function extractTokens ({ requestId, usage }) {
  const {
    inputTokensFromHeaders,
    outputTokensFromHeaders
  } = requestIdsToTokens[requestId] || {}
  delete requestIdsToTokens[requestId]

  const inputTokens = usage.inputTokens || inputTokensFromHeaders || 0
  const outputTokens = usage.outputTokens || outputTokensFromHeaders || 0

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
