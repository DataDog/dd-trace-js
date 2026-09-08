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
const { appendMessage } = require('./anthropic/util')
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

      const inputTokenCount = getHeader(headers, 'x-amzn-bedrock-input-token-count')
      const outputTokenCount = getHeader(headers, 'x-amzn-bedrock-output-token-count')
      const cacheReadTokenCount = getHeader(headers, 'x-amzn-bedrock-cache-read-input-token-count')
      const cacheWriteTokenCount = getHeader(headers, 'x-amzn-bedrock-cache-write-input-token-count')

      pendingTokenHeaders.set(requestId, {
        inputTokensFromHeaders: parseHeaderCount(inputTokenCount),
        outputTokensFromHeaders: parseHeaderCount(outputTokenCount),
        cacheReadTokensFromHeaders: parseHeaderCount(cacheReadTokenCount),
        cacheWriteTokensFromHeaders: parseHeaderCount(cacheWriteTokenCount),
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
    this.#tagCommon({
      span,
      requestParams,
      inputMessages: requestParams.prompt,
      outputMessages: textAndResponseReason.messages,
      usage: textAndResponseReason.usage,
      tokensFromHeaders,
    })
  }

  #tagInvokeModelSpan ({ ctx, request, span, response, modelProvider, modelName, tokensFromHeaders, isStream }) {
    const requestParams = extractRequestParams(request.params, modelProvider)
    // for streamed responses, we'll use the coerced response object we formed in the stream handler
    const textAndResponseReason = isStream
      ? extractTextAndResponseReasonFromStream(ctx.chunks, modelProvider, modelName)
      : extractTextAndResponseReason(response, modelProvider, modelName)

    if (requestParams.tools?.length > 0) {
      this._tagger.tagToolDefinitions(span, requestParams.tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        schema: tool.input_schema ?? {},
      })))
    }

    // Only the Anthropic Messages API request shape yields an array prompt / block-array output content.
    const inputMessages = Array.isArray(requestParams.prompt)
      ? formatAnthropicInputMessages(requestParams)
      : requestParams.prompt
    const outputMessages = textAndResponseReason.content === undefined
      ? textAndResponseReason.messages
      : formatAnthropicMessages('assistant', textAndResponseReason.content)

    this.#tagCommon({
      span,
      requestParams,
      inputMessages,
      outputMessages,
      usage: textAndResponseReason.usage,
      tokensFromHeaders,
    })
  }

  #tagCommon ({ span, requestParams, inputMessages, outputMessages, usage, tokensFromHeaders }) {
    const metadata = {}
    if (requestParams.temperature !== undefined && requestParams.temperature !== null) {
      metadata.temperature = Number.parseFloat(requestParams.temperature)
    }
    if (requestParams.maxTokens !== undefined && requestParams.maxTokens !== null) {
      metadata.max_tokens = Number.parseInt(requestParams.maxTokens, 10)
    }
    this._tagger.tagMetadata(span, metadata)

    this._tagger.tagLLMIO(span, inputMessages, outputMessages)
    this._tagger.tagMetrics(span, extractTokens({ tokensFromHeaders, usage }))
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

function getHeader (headers, name) {
  const key = Object.keys(headers).find(header => header.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

function parseHeaderCount (value) {
  if (value == null) return
  const count = Number.parseInt(value, 10)
  return Number.isNaN(count) ? undefined : count
}

function formatAnthropicInputMessages (requestParams) {
  const messages = []
  if (requestParams.system !== undefined) {
    appendMessage(messages, { role: 'system', content: requestParams.system })
  }
  for (const message of requestParams.prompt) {
    appendMessage(messages, message)
  }
  return messages
}

function formatAnthropicMessages (role, content) {
  const messages = []
  appendMessage(messages, { role, content })
  return messages
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

  const inputTokens = typeof usage?.inputTokens === 'number'
    ? usage.inputTokens
    : inputTokensFromHeaders
  const outputTokens = typeof usage?.outputTokens === 'number'
    ? usage.outputTokens
    : outputTokensFromHeaders
  const cacheReadTokens = typeof usage?.cacheReadTokens === 'number'
    ? usage.cacheReadTokens
    : cacheReadTokensFromHeaders
  const cacheWriteTokens = typeof usage?.cacheWriteTokens === 'number'
    ? usage.cacheWriteTokens
    : cacheWriteTokensFromHeaders

  if (inputTokens === undefined && outputTokens === undefined) return {}

  // Adjust for the fact that Bedrock input tokens only count non-cached tokens.
  const normalizedInputTokens = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const metrics = {
    totalTokens: normalizedInputTokens + (outputTokens ?? 0),
  }
  if (inputTokens !== undefined) metrics.inputTokens = normalizedInputTokens
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens
  if (cacheReadTokens !== undefined) metrics.cacheReadTokens = cacheReadTokens
  if (cacheWriteTokens !== undefined) metrics.cacheWriteTokens = cacheWriteTokens

  return metrics
}

module.exports = BedrockRuntimeLLMObsPlugin
