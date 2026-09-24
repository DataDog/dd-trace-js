'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
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
const BaseLLMObsPlugin = require('./base')

const llmobsStore = storage('llmobs')

const ENABLED_OPERATIONS = new Set([
  'invokeModel',
  'invokeModelWithResponseStream',
  'converse',
  'converseStream',
])
const CONVERSE_OPERATIONS = new Set(['converse', 'converseStream'])

// The fields the stream extractor reads token counts out of: the invocation metrics every provider
// can send, Amazon's own pair, and Anthropic's `message.usage`. Matching is a byte search over the
// raw frame, so a chunk carrying nothing but generated text is dropped instead of held until the
// response completes. Quoted, so that a field name matches and prose does not: a quote inside a
// JSON string arrives escaped, leaving `\"usage\"` where the closing quote would be.
const USAGE_MARKERS = [
  '"amazon-bedrock-invocationMetrics"',
  '"inputTextTokenCount"',
  '"totalOutputTextTokenCount"',
  '"usage"',
].map(field => Buffer.from(field))

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
        // Converse reports usage on the response or a metadata event, in its own spelling; a
        // streamed `invokeModel` reports it in the chunk bodies, which the shared extractor
        // normalizes per provider
        const converseUsage = CONVERSE_OPERATIONS.has(operation) ? response.usage ?? ctx.streamedUsage : undefined
        const usage = converseUsage
          ? buildUsage(converseUsage)
          : streamedInvokeModelUsage(ctx, modelProvider, modelName)

        this._setGenAiApmTags(span, {
          spanKind: 'llm',
          modelName: modelId.toLowerCase(),
          modelProvider: 'amazon_bedrock',
          // reporting zeros for every metric would be worse than reporting none
          metrics: tokensFromHeaders || usage
            ? extractTokens({ tokensFromHeaders, usage: usage ?? {} })
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

      pendingTokenHeaders.set(requestId, {
        inputTokensFromHeaders: inputTokenCount && Number.parseInt(inputTokenCount, 10),
        outputTokensFromHeaders: outputTokenCount && Number.parseInt(outputTokenCount, 10),
        cacheReadTokensFromHeaders: cacheReadTokenCount && Number.parseInt(cacheReadTokenCount, 10),
        cacheWriteTokensFromHeaders: cacheWriteTokenCount && Number.parseInt(cacheWriteTokenCount, 10),
      })
    })

    this.addSub('apm:aws:response:streamed-chunk:bedrockruntime', ({ ctx, chunk }) => {
      if (!this._llmobsEnabled) {
        // Converse reports usage on a metadata event; `invokeModel` streams report it in a chunk
        // body, in a shape that varies by provider, so those are read through the shared
        // extractor at `:complete:` once the model id names the provider. Only the frames that
        // can carry a count are kept: the rest is generated content this path never reads.
        const usage = chunk?.metadata?.usage
        if (usage) {
          ctx.streamedUsage = usage
        } else if (carriesUsage(chunk)) {
          ctx.chunks ??= []
          ctx.chunks.push(chunk)
        }
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
 * @param {string | undefined} requestId
 * @returns {HeaderTokens | undefined}
 */
function consumeTokenHeaders (requestId) {
  const tokens = pendingTokenHeaders.get(requestId)
  pendingTokenHeaders.delete(requestId)
  return tokens
}

/**
 * Whether a streamed `invokeModel` frame can carry a token count, decided on the raw bytes so a
 * text-only frame costs a byte search rather than a decode, a parse and the memory to hold it.
 *
 * @param {{ chunk?: { bytes?: Uint8Array } }} [chunk]
 */
function carriesUsage (chunk) {
  const bytes = chunk?.chunk?.bytes
  if (!ArrayBuffer.isView(bytes)) return false

  // a view, not a copy: this runs on every frame of every streamed response
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return USAGE_MARKERS.some(marker => body.includes(marker))
}

/**
 * Token usage for a streamed `invokeModel` call. Each provider reports it in its own shape, and
 * some only through `amazon-bedrock-invocationMetrics`, so this defers to the same extractor the
 * LLMObs path uses rather than reimplementing that knowledge.
 *
 * @param {{ chunks?: Array<object> }} ctx
 * @param {string} modelProvider
 * @param {string} modelName
 * @returns {Record<string, number | undefined> | undefined}
 */
function streamedInvokeModelUsage (ctx, modelProvider, modelName) {
  if (!ctx.chunks?.length) return

  let generation
  try {
    generation = extractTextAndResponseReasonFromStream(ctx.chunks, modelProvider, modelName)
  } catch (e) {
    // the extractor parses each chunk body; a malformed one must not reach the application
    log.debug('Failed to read streamed Bedrock usage:', e.message)
    return
  }

  // already on the LLMObs metric names, the same ones `buildUsage` maps the Converse shape onto
  const usage = generation.usage
  if (!usage?.inputTokens && !usage?.outputTokens && !usage?.cacheReadTokens && !usage?.cacheWriteTokens) return

  return usage
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
