'use strict'

const { storage } = require('../../../../datadog-core')
const telemetry = require('../telemetry')
const {
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId,
  extractTextAndResponseReasonFromStream,
} = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')
const BaseLLMObsPlugin = require('./base')

const llmobsStore = storage('llmobs')

const ENABLED_OPERATIONS = new Set(['invokeModel', 'invokeModelWithResponseStream'])

/**
 * @typedef {{
 *   inputTokensFromHeaders?: number,
 *   outputTokensFromHeaders?: number,
 *   cacheReadTokensFromHeaders?: number,
 *   cacheWriteTokensFromHeaders?: number,
 * }} HeaderTokens
 */

/** @type {Map<string, HeaderTokens>} */
const pendingTokenHeaders = new Map()

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', (ctx) => {
      const { response } = ctx
      const request = response.request
      const operation = request.operation

      // Release the cached headers even for operations the plugin does not tag,
      // so non-LLM Bedrock calls do not leak entries into pendingTokenHeaders.
      const tokensFromHeaders = consumeTokenHeaders(response.$metadata?.requestId)

      // avoids instrumenting other non supported runtime operations
      if (!ENABLED_OPERATIONS.has(operation)) return

      const { modelProvider, modelName } = parseModelId(request.params.modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) return

      const span = ctx.currentStore?.span
      this.setLLMObsTags({ ctx, request, span, response, modelProvider, modelName, tokensFromHeaders })
    })

    this.addSub('apm:aws:response:deserialize:bedrockruntime', ({ headers }) => {
      const requestId = headers['x-amzn-requestid']
      // No request id means no way to correlate with the :complete: event.
      if (!requestId) return

      const inputTokenCount = headers['x-amzn-bedrock-input-token-count']
      const outputTokenCount = headers['x-amzn-bedrock-output-token-count']
      const cacheReadTokenCount = headers['x-amzn-bedrock-cache-read-input-token-count']
      const cacheWriteTokenCount = headers['x-amzn-bedrock-cache-write-input-token-count']

      pendingTokenHeaders.set(requestId, {
        inputTokensFromHeaders: inputTokenCount && Number.parseInt(inputTokenCount),
        outputTokensFromHeaders: outputTokenCount && Number.parseInt(outputTokenCount),
        cacheReadTokensFromHeaders: cacheReadTokenCount && Number.parseInt(cacheReadTokenCount),
        cacheWriteTokensFromHeaders: cacheWriteTokenCount && Number.parseInt(cacheWriteTokenCount),
      })
    })

    this.addSub('apm:aws:response:streamed-chunk:bedrockruntime', ({ ctx, chunk }) => {
      if (!ctx.chunks) ctx.chunks = []

      if (chunk) ctx.chunks.push(chunk)
    })
  }

  setLLMObsTags ({ ctx, request, span, response, modelProvider, modelName, tokensFromHeaders }) {
    const isStream = request?.operation?.toLowerCase().includes('stream')
    telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: true, integration: 'bedrock' })

    const parent = llmobsStore.getStore()?.span
    // Use full modelId and unified provider for LLMObs (required for backend cost estimation).
    // Split modelProvider/modelName from parseModelId() are still used below for response parsing.
    this._tagger.registerLLMObsSpan(span, {
      parent,
      modelName: request.params.modelId.toLowerCase(),
      modelProvider: 'amazon_bedrock',
      kind: 'llm',
      name: 'bedrock-runtime.command',
      integration: 'bedrock',
    })

    const requestParams = extractRequestParams(request.params, modelProvider)
    // for streamed responses, we'll use the coerced response object we formed in the stream handler
    const textAndResponseReason = isStream
      ? extractTextAndResponseReasonFromStream(ctx.chunks, modelProvider, modelName)
      : extractTextAndResponseReason(response, modelProvider, modelName)

    // add metadata tags
    this._tagger.tagMetadata(span, {
      temperature: Number.parseFloat(requestParams.temperature) || 0,
      max_tokens: Number.parseInt(requestParams.maxTokens) || 0,
    })

    // add I/O tags
    this._tagger.tagLLMIO(
      span,
      requestParams.prompt,
      [{ content: textAndResponseReason.message, role: textAndResponseReason.role }]
    )

    // add token metrics
    const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens } = extractTokens({
      tokensFromHeaders,
      usage: textAndResponseReason.usage,
    })
    this._tagger.tagMetrics(span, {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
    })
  }
}

/**
 * @param {string | undefined} requestId
 * @returns {HeaderTokens | undefined}
 */
function consumeTokenHeaders (requestId) {
  const tokens = pendingTokenHeaders.get(requestId)
  pendingTokenHeaders.delete(requestId)
  return tokens
}

/**
 * Combine response-body usage with header-derived counts, preferring the body.
 *
 * @param {{ tokensFromHeaders: HeaderTokens | undefined, usage: Record<string, number | undefined> }} options
 */
function extractTokens ({ tokensFromHeaders, usage }) {
  const {
    inputTokensFromHeaders,
    outputTokensFromHeaders,
    cacheReadTokensFromHeaders,
    cacheWriteTokensFromHeaders,
  } = tokensFromHeaders ?? {}

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
    cacheWriteTokens,
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
