'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const telemetry = require('../telemetry')
const { safeJsonParse } = require('../util')
const {
  buildUsage,
  extractRequestParams,
  extractTextAndResponseReason,
  mergeStreamedUsage,
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

      // the SDK rejects a request with no model id, and the parser assumes a string
      const modelId = request.params?.modelId
      if (typeof modelId !== 'string') return

      const { modelProvider, modelName } = parseModelId(modelId)

      // avoids instrumenting non llm type
      if (modelName.includes('embed')) return

      const span = ctx.currentStore?.span
      if (!span) return

      if (!this._llmobsEnabledFor(ctx)) {
        // no LLMObs payload to build, so the usage comes from the response headers and, where
        // those are absent, from whatever reported it
        let usage
        if (CONVERSE_OPERATIONS.has(operation)) {
          // a non-streamed Converse puts it on the response, a streamed one on a metadata event
          usage = buildUsage(response.usage) ?? ctx.streamedUsage
        } else if (operation.toLowerCase().includes('stream')) {
          // every streamed frame was folded into the running totals as it arrived
          usage = ctx.streamedUsage
        } else if (!tokensFromHeaders) {
          usage = responseBodyUsage(response, modelProvider, modelName)
        }

        this._setGenAiApmTags(span, {
          spanKind: 'llm',
          modelName: modelId.toLowerCase(),
          modelProvider: 'amazon_bedrock',
          // a count no source reported comes back undefined and is left off the span: reporting
          // zeros for every metric would be worse than reporting none
          metrics: extractTokens({ tokensFromHeaders, usage: usage ?? {} }),
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
      if (!this._llmobsEnabledFor(ctx)) {
        // only the token counts are needed, for the `gen_ai.usage.*` metrics; the generated
        // content is left to the LLMObs path, so nothing is retained past the running totals
        ctx.streamedUsage = mergeChunkUsage(ctx, chunk)
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
    this._tagger.tagMetrics(span, zeroFilled(extractTokens({
      tokensFromHeaders,
      usage: textAndResponseReason.usage,
    })))
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
 * Fold one streamed frame's token counts into the totals on `ctx`. Converse reports them on a
 * metadata event; `invokeModel` reports them in the frame body, in a shape that varies by
 * provider, so the body is read through the same table the LLMObs path uses.
 *
 * @param {object} ctx
 * @param {object} [chunk]
 * @returns {import('../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils')
 *   .StreamedUsage | undefined}
 */
function mergeChunkUsage (ctx, chunk) {
  const metadataUsage = chunk?.metadata?.usage
  if (metadataUsage) return buildUsage(metadataUsage) ?? ctx.streamedUsage

  const bytes = chunk?.chunk?.bytes
  if (!ArrayBuffer.isView(bytes)) return ctx.streamedUsage

  // a view, not a copy: this runs on every frame of every streamed response
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8')
  const body = safeJsonParse(text, null)
  // a frame the model filled with generated text rather than JSON must not reach the application
  if (typeof body !== 'object' || body === null) return ctx.streamedUsage

  return mergeStreamedUsage(ctx.streamedUsage, body, streamModelProvider(ctx))
}

/**
 * Token usage a non-streamed `invokeModel` reports in its own response body, which several
 * providers carry and the headers do not always correlate. Read through the same extractor the
 * LLMObs path uses, and only when the headers reported nothing: parsing a body to recover counts
 * already in hand is work this path does not need.
 *
 * @param {{ body?: Uint8Array }} response
 * @param {string} modelProvider
 * @param {string} modelName
 * @returns {Record<string, number | undefined> | undefined}
 */
function responseBodyUsage (response, modelProvider, modelName) {
  if (!response?.body) return

  try {
    return extractTextAndResponseReason(response, modelProvider, modelName).usage
  } catch (e) {
    // the extractor parses the body itself; a malformed one must not disable the plugin
    log.debug('Failed to read Bedrock response usage: %s', e.message)
  }
}

/**
 * The provider is fixed for the life of the stream, so it is parsed off the request once.
 *
 * @param {object} ctx
 */
function streamModelProvider (ctx) {
  if (ctx.streamModelProvider === undefined) {
    const modelId = (ctx.request ?? ctx.response?.request)?.params?.modelId
    ctx.streamModelProvider = typeof modelId === 'string'
      ? parseModelId(modelId).modelProvider.toUpperCase()
      : ''
  }

  return ctx.streamModelProvider
}

/**
 * Combine response-body usage with header-derived counts, preferring the body. A count no source
 * reported stays undefined rather than becoming a zero that reads as a measurement.
 *
 * @param {{ tokensFromHeaders: HeaderTokens | undefined, usage: Record<string, number | undefined> }} options
 * @returns {Record<string, number | undefined>}
 */
function extractTokens ({ tokensFromHeaders, usage }) {
  const {
    inputTokensFromHeaders,
    outputTokensFromHeaders,
    cacheReadTokensFromHeaders,
    cacheWriteTokensFromHeaders,
  } = tokensFromHeaders ?? {}

  const inputTokens = resolveCount(usage.inputTokens, inputTokensFromHeaders)
  const outputTokens = resolveCount(usage.outputTokens, outputTokensFromHeaders)
  const cacheReadTokens = resolveCount(usage.cacheReadTokens, cacheReadTokensFromHeaders)
  const cacheWriteTokens = resolveCount(usage.cacheWriteTokens, cacheWriteTokensFromHeaders)

  // adjust for the fact that bedrock input tokens only count non-cached tokens
  const normalizedInputTokens = inputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
    ? undefined
    : (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)

  const totalTokens = normalizedInputTokens === undefined && outputTokens === undefined
    ? undefined
    : (normalizedInputTokens ?? 0) + (outputTokens ?? 0)

  return {
    inputTokens: normalizedInputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

/**
 * The body wins over the headers, and a value neither reported as a number is left undefined:
 * header counts are parsed from strings and can arrive empty.
 *
 * @param {unknown} fromBody
 * @param {unknown} fromHeaders
 * @returns {number | undefined}
 */
function resolveCount (fromBody, fromHeaders) {
  const value = fromBody || fromHeaders
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined
}

/**
 * The LLMObs metrics contract reports an unmeasured count as zero, where the `gen_ai.*` APM
 * attributes leave it off the span entirely.
 *
 * @param {Record<string, number | undefined>} tokens
 * @returns {Record<string, number>}
 */
function zeroFilled (tokens) {
  return {
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    totalTokens: tokens.totalTokens ?? 0,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
  }
}

module.exports = BedrockRuntimeLLMObsPlugin
