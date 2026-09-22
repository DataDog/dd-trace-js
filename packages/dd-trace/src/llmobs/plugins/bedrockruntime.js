'use strict'

const { storage } = require('../../../../datadog-core')
const telemetry = require('../telemetry')
const {
  buildUsage,
  extractRequestParams,
  extractTextAndResponseReason,
  parseModelId,
  extractTextAndResponseReasonFromStream,
  extractConverseToolDefinitions,
  extractRequestParamsConverse,
  extractTextAndResponseReasonConverse,
  extractTextAndResponseReasonConverseFromStream,
} = require('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')
const { safeJsonParse } = require('../util')
const BaseLLMObsPlugin = require('./base')

const llmobsStore = storage('llmobs')

const ENABLED_OPERATIONS = new Set([
  'invokeModel',
  'invokeModelWithResponseStream',
  'converse',
  'converseStream',
])
const CONVERSE_OPERATIONS = new Set(['converse', 'converseStream'])
const INVOCATION_METRICS_KEY = 'amazon-bedrock-invocationMetrics'

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

// Headers are published per attempt, so a retried or aborted request leaves entries no `:complete:`
// will ever claim. Bound the cache and evict oldest-first rather than grow with every one of them.
const MAX_PENDING_TOKEN_HEADERS = 1000

class BedrockRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  constructor () {
    super(...arguments)

    this.addSub('apm:aws:request:complete:bedrockruntime', (ctx) => {
      const { response } = ctx
      const request = response.request
      const operation = request.operation

      // Release the cached headers even for operations the plugin does not tag,
      // so non-LLM Bedrock calls do not leak entries into pendingTokenHeaders.
      const tokensFromHeaders = consumeTokenHeaders(getRequestId(response))

      // avoids instrumenting other non supported runtime operations
      if (!ENABLED_OPERATIONS.has(operation)) return

      // the SDK rejects a request with no model id, and the parser assumes a string
      const modelId = request.params?.modelId
      if (typeof modelId !== 'string') return

      const { modelProvider, modelName } = parseModelId(modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) return

      const span = ctx.currentStore?.span
      if (!span) return

      if (!this._llmobsEnabled) {
        // no LLMObs payload to build, so the usage comes from the response headers and, where
        // those are absent, from the response or the chunk that reported it: Converse puts it on
        // the response, and every streamed operation puts it on a chunk
        const responseUsage = CONVERSE_OPERATIONS.has(operation) ? response.usage : undefined
        const usage = responseUsage ?? ctx.streamedUsage

        this._setGenAiApmTags(span, {
          spanKind: 'llm',
          modelName: modelId.toLowerCase(),
          modelProvider: 'amazon_bedrock',
          // reporting zeros for every metric would be worse than reporting none
          metrics: tokensFromHeaders || usage
            ? extractTokens({ tokensFromHeaders, usage: buildUsage(usage) })
            : undefined,
        })
        return
      }

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

      // Responses that report no counts at all, error responses included, would otherwise cache a
      // record of undefined fields that reads as a measurement of zero.
      if (!inputTokenCount && !outputTokenCount && !cacheReadTokenCount && !cacheWriteTokenCount) return

      cacheTokenHeaders(requestId, {
        inputTokensFromHeaders: inputTokenCount && Number.parseInt(inputTokenCount, 10),
        outputTokensFromHeaders: outputTokenCount && Number.parseInt(outputTokenCount, 10),
        cacheReadTokensFromHeaders: cacheReadTokenCount && Number.parseInt(cacheReadTokenCount, 10),
        cacheWriteTokensFromHeaders: cacheWriteTokenCount && Number.parseInt(cacheWriteTokenCount, 10),
      })
    })

    this.addSub('apm:aws:response:streamed-chunk:bedrockruntime', ({ ctx, chunk }) => {
      if (!this._llmobsEnabled) {
        // only the token usage is needed, for the `gen_ai.usage.*` metrics; the message bodies are
        // left to the LLMObs path
        const usage = chunk?.metadata?.usage ?? readInvocationMetrics(chunk)
        if (usage) ctx.streamedUsage = usage
        return
      }

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
      max_tokens: Number.parseInt(requestParams.maxTokens, 10) || 0,
    })
    this._tagger.tagLLMIO(span, requestParams.prompt, textAndResponseReason.messages)
    this._tagger.tagMetrics(span, extractTokens({
      tokensFromHeaders,
      usage: textAndResponseReason.usage,
    }))
  }
}

/**
 * The request id sits on the response metadata, or on the error's for a failed request: the
 * rejection path builds a response with no top-level `$metadata`.
 *
 * @param {{ $metadata?: { requestId?: string }, error?: { $metadata?: { requestId?: string } } }} response
 * @returns {string | undefined}
 */
function getRequestId (response) {
  return response.$metadata?.requestId ?? response.error?.$metadata?.requestId
}

/**
 * @param {string} requestId
 * @param {HeaderTokens} tokens
 */
function cacheTokenHeaders (requestId, tokens) {
  if (pendingTokenHeaders.size >= MAX_PENDING_TOKEN_HEADERS) {
    pendingTokenHeaders.delete(/** @type {string} */ (pendingTokenHeaders.keys().next().value))
  }

  pendingTokenHeaders.set(requestId, tokens)
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
 * `invokeModelWithResponseStream` reports its token counts in the body of one chunk instead of in
 * the headers `invokeModel` sends. Searches the raw bytes for the key first, so every other chunk
 * on a streamed response costs a byte scan rather than a decode and a parse.
 *
 * @param {{ chunk?: { bytes?: Uint8Array } }} [chunk]
 * @returns {Record<string, number> | undefined}
 */
function readInvocationMetrics (chunk) {
  const bytes = chunk?.chunk?.bytes
  if (!ArrayBuffer.isView(bytes)) return

  // a view, not a copy: this runs on every chunk of every streamed response
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!body.includes(INVOCATION_METRICS_KEY)) return

  return safeJsonParse(body.toString('utf8'), null)?.[INVOCATION_METRICS_KEY]
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
