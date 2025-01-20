const BaseLLMObsPlugin = require('./base')
const { storage } = require('../../../../datadog-core')
const llmobsStore = storage('llmobs')

// eslint-disable-next-line @stylistic/js/max-len
const { extractRequestParams, extractTextAndResponseReason, parseModelId } = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')

const enabledOperations = ['invokeModel']

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', ({ response }) => {
      const operation = response.request.operation
      // avoids instrumenting other non supported runtime operations
      if (!enabledOperations.includes(operation)) {
        return
      }
      const { modelName } = parseModelId(response.request.params.modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) {
        return
      }
      const request = response.request
      const span = storage.getStore()?.span
      this.setLLMObsTags({ request, span, response })
    })
  }

  setLLMObsTags ({ request, span, response }) {
    const { modelProvider, modelName } = parseModelId(request.params.modelId)

    const parent = llmobsStore.getStore()?.span
    this._tagger.registerLLMObsSpan(span, {
      parent,
      modelName: modelName.toLowerCase(),
      modelProvider: modelProvider.toLowerCase(),
      kind: 'llm',
      name: 'bedrock-runtime.invokeModel'
    })

    const requestParams = extractRequestParams(request.params, modelProvider)
    const textAndResponseReason = extractTextAndResponseReason(response, modelProvider, modelName)

    // add metadata tags
    this._tagger.tagMetadata(span, {
      temperature: parseFloat(requestParams.temperature) || 0.0,
      max_tokens: parseInt(requestParams.maxTokens) || 0
    })

    // add I/O tags
    if (modelName.includes('embed')) {
      this._tagger.tagEmbeddingIO(span, requestParams.prompt, textAndResponseReason.message)
    } else {
      this._tagger.tagLLMIO(span, requestParams.prompt, textAndResponseReason.message)
    }
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
