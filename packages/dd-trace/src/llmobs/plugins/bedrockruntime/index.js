'use strict'

const BaseLLMObsPlugin = require('../base')
const { storage } = require('../../../../../datadog-core')
const llmobsStore = storage('llmobs')
const telemetry = require('../../telemetry')

const { parseModelId } = require('../../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')
const {
  extractRequestParams,
  extractTextAndResponseReason,
  extractTextAndResponseReasonFromStream,
} = require('./utils')

const ENABLED_OPERATIONS = new Set(['invokeModel', 'invokeModelWithResponseStream'])

const requestIdsToTokens = {}

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', (ctx) => {
      const { response } = ctx
      const request = response.request
      const operation = request.operation
      // avoids instrumenting other non supported runtime operations
      if (!ENABLED_OPERATIONS.has(operation)) {
        return
      }
      const { modelProvider, modelName } = parseModelId(request.params.modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) {
        return
      }
      const span = ctx.currentStore?.span
      this.setLLMObsTags({ ctx, request, span, response, modelProvider, modelName })
    })

    this.addSub('apm:aws:response:deserialize:bedrockruntime', ({ headers }) => {
      const requestId = headers['x-amzn-requestid']
      const inputTokenCount = headers['x-amzn-bedrock-input-token-count']
      const outputTokenCount = headers['x-amzn-bedrock-output-token-count']
      const cacheReadTokenCount = headers['x-amzn-bedrock-cache-read-input-token-count']
      const cacheWriteTokenCount = headers['x-amzn-bedrock-cache-write-input-token-count']

      requestIdsToTokens[requestId] = {
        inputTokensFromHeaders: inputTokenCount && Number.parseInt(inputTokenCount),
        outputTokensFromHeaders: outputTokenCount && Number.parseInt(outputTokenCount),
        cacheReadTokensFromHeaders: cacheReadTokenCount && Number.parseInt(cacheReadTokenCount),
        cacheWriteTokensFromHeaders: cacheWriteTokenCount && Number.parseInt(cacheWriteTokenCount)
      }
    })

    this.addSub('apm:aws:response:streamed-chunk:bedrockruntime', ({ ctx, chunk }) => {
      if (!ctx.chunks) ctx.chunks = []

      if (chunk) ctx.chunks.push(chunk)
    })
  }

  setLLMObsTags ({ ctx, request, span, response, modelProvider, modelName }) {
    const isStream = request?.operation?.toLowerCase().includes('stream')
    telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: true, integration: 'bedrock' })

    const parent = llmobsStore.getStore()?.span
    this._tagger.registerLLMObsSpan(span, {
      parent,
      modelName: modelName.toLowerCase(),
      modelProvider: modelProvider.toLowerCase(),
      kind: 'llm',
      name: 'bedrock-runtime.command',
      integration: 'bedrock'
    })

    const requestParams = extractRequestParams(request.params, modelProvider)
    // for streamed responses, we'll use the coerced response object we formed in the stream handler
    const textAndResponseReason = isStream
      ? extractTextAndResponseReasonFromStream(ctx.chunks, modelProvider, modelName)
      : extractTextAndResponseReason(response, modelProvider, modelName)

    // add metadata tags
    this._tagger.tagMetadata(span, {
      temperature: Number.parseFloat(requestParams.temperature) || 0,
      max_tokens: Number.parseInt(requestParams.maxTokens) || 0
    })

    // add I/O tags
    this._tagger.tagLLMIO(
      span,
      requestParams.prompt,
      [{ content: textAndResponseReason.message, role: textAndResponseReason.role }]
    )

    // add token metrics
    const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = extractTokens({
      requestId: response.$metadata.requestId,
      usage: textAndResponseReason.usage
    })
    this._tagger.tagMetrics(span, {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens
    })
  }
}

function extractTokens ({ requestId, usage }) {
  const {
    inputTokensFromHeaders,
    outputTokensFromHeaders,
    cacheReadTokensFromHeaders,
    cacheWriteTokensFromHeaders
  } = requestIdsToTokens[requestId] || {}
  delete requestIdsToTokens[requestId]

  const inputTokens = usage.inputTokens || inputTokensFromHeaders || 0
  const outputTokens = usage.outputTokens || outputTokensFromHeaders || 0
  const cacheReadTokens = usage.cacheReadTokens || cacheReadTokensFromHeaders || 0
  const cacheWriteTokens = usage.cacheWriteTokens || cacheWriteTokensFromHeaders || 0

  // adjust for the fact that bedrock input tokens only count non-cached tokens
  const normalizedInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens

  return {
    inputTokens: normalizedInputTokens,
    outputTokens,
    totalTokens: normalizedInputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
