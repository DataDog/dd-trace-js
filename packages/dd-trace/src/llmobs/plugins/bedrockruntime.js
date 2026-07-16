'use strict'

const { storage } = require('../../../../datadog-core')
const telemetry = require('../telemetry')
const {
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId,
  extractTextAndResponseReasonFromStream,
  extractConverseToolDefinitions,
  extractRequestParamsConverse,
  extractTextAndResponseReasonConverse,
  extractTextAndResponseReasonConverseFromStream,
} = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')
const BaseLLMObsPlugin = require('./base')

const llmobsStore = storage('llmobs')

const ENABLED_OPERATIONS = new Set([
  'invokeModel',
  'invokeModelWithResponseStream',
  'converse',
  'converseStream',
])
const CONVERSE_OPERATIONS = new Set(['converse', 'converseStream'])

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
    this.#registerSpan(span, request)

    if (CONVERSE_OPERATIONS.has(request?.operation)) {
      this.#tagConverseSpan({ ctx, request, span, response, tokensFromHeaders, isStream })
    } else {
      this.#tagInvokeModelSpan({ ctx, request, span, response, modelProvider, modelName, tokensFromHeaders, isStream })
    }
  }

  #registerSpan (span, request) {
    const parent = llmobsStore.getStore()?.span
    // Use full modelId and unified provider for LLMObs (required for backend cost estimation).
    this._tagger.registerLLMObsSpan(span, {
      parent,
      modelName: request.params.modelId.toLowerCase(),
      modelProvider: 'amazon_bedrock',
      kind: 'llm',
      name: 'bedrock-runtime.command',
      integration: 'bedrock',
    })
  }

  #tagConverseSpan ({ ctx, request, span, response, tokensFromHeaders, isStream }) {
    const requestParams = extractRequestParamsConverse(request.params)
    const textAndResponseReason = isStream
      ? extractTextAndResponseReasonConverseFromStream(ctx.chunks)
      : extractTextAndResponseReasonConverse(response)

    const toolDefinitions = extractConverseToolDefinitions(request.params)
    if (toolDefinitions.length > 0) this._tagger.tagToolDefinitions(span, toolDefinitions)
    if (textAndResponseReason.finishReason) {
      this._tagger.tagMetadata(span, { stop_reason: textAndResponseReason.finishReason })
    }
    this.#tagCommon({ span, requestParams, textAndResponseReason, tokensFromHeaders })
  }

  #tagInvokeModelSpan ({ ctx, request, span, response, modelProvider, modelName, tokensFromHeaders, isStream }) {
    const requestParams = extractRequestParams(request.params, modelProvider)
    // for streamed responses, we'll use the coerced response object we formed in the stream handler
    const textAndResponseReason = isStream
      ? extractTextAndResponseReasonFromStream(ctx.chunks, modelProvider, modelName)
      : extractTextAndResponseReason(response, modelProvider, modelName)

    this.#tagCommon({ span, requestParams, textAndResponseReason, tokensFromHeaders })
  }

  #tagCommon ({ span, requestParams, textAndResponseReason, tokensFromHeaders }) {
    this._tagger.tagMetadata(span, {
      temperature: Number.parseFloat(requestParams.temperature) || 0,
      max_tokens: Number.parseInt(requestParams.maxTokens) || 0,
    })
    this._tagger.tagLLMIO(span, requestParams.prompt, textAndResponseReason.messages)
    this._tagger.tagMetrics(span, extractTokens({
      tokensFromHeaders,
      usage: textAndResponseReason.usage,
    }))
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
