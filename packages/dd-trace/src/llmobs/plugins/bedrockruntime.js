const BaseLLMObsPlugin = require('./base')
const { storage } = require('../../../../datadog-core')
const llmobsStore = storage('llmobs')

const {
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId
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

    this.addSub('apm:aws:token:bedrockruntime', ({ requestId, inputTokenCount, outputTokenCount }) => {
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
    this._tagger.tagLLMIO(span, requestParams.prompt, textAndResponseReason.message)

    // add token metrics
    const { inputTokens, outputTokens, totalTokens } = this.extractTokens({ response })
    this._tagger.tagMetrics(span, {
      inputTokens,
      outputTokens,
      totalTokens
    })
  }

  extractTokens ({ response }) {
    const requestId = response.$metadata.requestId
    const { inputTokenCount, outputTokenCount } = requestIdsToTokens[requestId] || {}
    delete requestIdsToTokens[requestId]

    const inputTokens = parseInt(inputTokenCount) || 0
    const outputTokens = parseInt(outputTokenCount) || 0

    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    }
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
