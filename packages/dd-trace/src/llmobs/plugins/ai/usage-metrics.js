'use strict'

const { DogStatsDClient, MetricsAggregationClient } = require('../../../dogstatsd')
const log = require('../../../log')
const { normalizeUsage } = require('./usage-tokens')

// Open Trajectory GenAI usage metrics for AI SDK calls made through the Vercel AI Gateway provider. They follow the
// profiles dd-trace-py's LiteLLM integration and libdd-ai-usage emit, under the same DogStatsD binding: Counts for
// counters, a Distribution with `.sum` and `.count` Counts for durations, and lower-cased tag values with every
// character outside `a-z0-9_-:./` replaced. They are observed in the application, so every point carries
// `trajectory.observation.point:client`.

const GATEWAY_PROVIDER = 'gateway'
const FLUSH_INTERVAL_MS = 10_000

const PROVIDER_ATTEMPT_PROFILE = 'trajectory.profile:gen_ai.client.provider_attempt/0.1.0'
const TOKEN_BREAKDOWN_PROFILE = 'trajectory.profile:trajectory.gen_ai.client.token_breakdown/0.1.0'
const UNKNOWN_MODALITY = 'gen_ai.token.modality:unknown'

// AI Gateway provider slugs that differ from the OpenTelemetry `gen_ai.provider.name` well-known values.
const PROVIDER_NAMES = {
  azure: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
  google: 'gcp.gemini',
  mistral: 'mistral_ai',
  moonshotai: 'moonshot_ai',
  vertex: 'gcp.vertex_ai',
  xai: 'x_ai',
}

/**
 * `providerMetadata.gateway`, as far as it is read here. See
 * https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering#provider-metadata-output
 *
 * @typedef {{ provider?: string, providerApiModelId?: string, success?: boolean }} GatewayProviderAttempt
 * @typedef {{ providerAttempts?: GatewayProviderAttempt[] }} GatewayModelAttempt
 * @typedef {{
 *   originalModelId?: string,
 *   resolvedProvider?: string,
 *   resolvedProviderApiModelId?: string,
 *   finalProvider?: string,
 *   modelAttempts?: GatewayModelAttempt[]
 * }} GatewayRouting
 * @typedef {{ routing?: GatewayRouting, cost?: string | number }} GatewayMetadata
 */

/**
 * One call, with the values as the AI SDK reports them: each is checked before use.
 *
 * @typedef {{
 *   requestModel?: unknown,
 *   responseModel?: unknown,
 *   providerMetadata?: unknown,
 *   usage: import('./usage-tokens').ReportedUsage,
 *   durationSeconds: number,
 *   error?: unknown
 * }} GatewayCall
 */

/**
 * Whether a raw AI SDK provider string, such as `ai.model.provider` or the telemetry event's `provider`, names the
 * AI Gateway provider.
 *
 * @param {unknown} provider
 */
function isGatewayProvider (provider) {
  return provider === GATEWAY_PROVIDER ||
    (typeof provider === 'string' && provider.startsWith(`${GATEWAY_PROVIDER}.`))
}

/**
 * A tag value as Datadog stores it.
 *
 * @param {string} value
 */
function tagValue (value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9_\-:./]/g, '_')
}

/**
 * A low-cardinality identifier: lower case, `[a-z0-9_.-]`, starting with a letter.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function identifier (value) {
  if (typeof value !== 'string' || !value) return
  const text = value.trim().toLowerCase().replaceAll(/[^a-z0-9_.-]/g, '_')
  return /^[a-z]/.test(text) ? text : undefined
}

/**
 * @param {unknown} slug AI Gateway provider slug
 */
function providerName (slug) {
  if (typeof slug !== 'string') return
  return PROVIDER_NAMES[slug] ?? identifier(slug)
}

/**
 * `GatewayRateLimitError` -> `gateway_rate_limit_error`, the way dd-trace-py names an exception class. AI SDK 4 to 6
 * record a failure as a plain `{ name, message, stack }` object, so its `name` stands in for the class.
 *
 * @param {unknown} error
 */
function errorType (error) {
  const className = error && typeof error === 'object' ? error.constructor?.name : undefined
  const name = className && className !== 'Object' ? className : /** @type {Error} */ (error)?.name
  const type = typeof name === 'string'
    ? identifier(name.replaceAll(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g, '_'))
    : undefined
  return type ?? 'error'
}

/**
 * The provider attempt that served the call, as `{provider}:{providerApiModelId}`, the form AI Gateway itself uses
 * for a model attempt's `modelId`.
 *
 * @param {GatewayRouting} routing
 * @returns {string | undefined}
 */
function destinationId (routing) {
  const modelAttempts = Array.isArray(routing.modelAttempts) ? routing.modelAttempts : []
  for (let i = modelAttempts.length - 1; i >= 0; i--) {
    const providerAttempts = modelAttempts[i]?.providerAttempts
    if (!Array.isArray(providerAttempts)) continue
    for (let j = providerAttempts.length - 1; j >= 0; j--) {
      const { success, provider, providerApiModelId } = providerAttempts[j] ?? {}
      if (success && provider && providerApiModelId) return `${provider}:${providerApiModelId}`
    }
  }

  const { finalProvider, resolvedProvider, resolvedProviderApiModelId } = routing
  const servedAsPlanned = resolvedProvider && resolvedProviderApiModelId &&
    (finalProvider ?? resolvedProvider) === resolvedProvider
  return servedAsPlanned ? `${resolvedProvider}:${resolvedProviderApiModelId}` : undefined
}

/**
 * The cost AI Gateway reports for the call: a decimal string of USD.
 *
 * @param {unknown} cost
 * @returns {number | undefined}
 */
function reportedCost (cost) {
  if (cost === undefined || cost === null || cost === '') return
  const usd = Number(cost)
  return Number.isFinite(usd) && usd >= 0 ? usd : undefined
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isText (value) {
  return typeof value === 'string' && value !== ''
}

class GatewayUsageMetrics {
  /** @type {import('../../../config/config-base')} */
  #config
  /** @type {MetricsAggregationClient | undefined} */
  #client
  /** @type {string | undefined} */
  #clientSourceTag

  /**
   * @param {import('../../../config/config-base')} config
   */
  constructor (config) {
    this.#config = config
    const clientSource = config.ai?.DD_AI_SDK_USAGE_METRICS_CLIENT_SOURCE
    if (clientSource) this.#clientSourceTag = `trajectory.client_source:${tagValue(clientSource)}`
  }

  /**
   * @param {GatewayCall} call
   */
  record (call) {
    try {
      this.#record(call)
    } catch (e) {
      log.debug('Failed to record AI SDK usage metrics: %s', e.message)
    }
  }

  /**
   * @param {GatewayCall} call
   */
  #record (call) {
    const metadata = /** @type {{ gateway?: GatewayMetadata } | undefined} */ (call.providerMetadata)
    const gateway = metadata?.gateway
    const routing = gateway?.routing && typeof gateway.routing === 'object' ? gateway.routing : undefined

    // `gen_ai.provider.name` is the provider the gateway routed to. Without routing metadata, such as on a call that
    // failed before the gateway answered, it is unknown and left out rather than guessed from the model id's creator.
    const tags = ['gen_ai.operation.name:chat', 'trajectory.observation.point:client']
    const providerSlug = routing?.finalProvider ?? routing?.resolvedProvider
    const provider = providerName(providerSlug)
    if (provider) tags.push(`gen_ai.provider.name:${tagValue(provider)}`)
    const { requestModel, responseModel } = call
    if (isText(requestModel)) tags.push(`gen_ai.request.model:${tagValue(requestModel)}`)
    if (isText(responseModel)) tags.push(`gen_ai.response.model:${tagValue(responseModel)}`)
    const route = routing?.originalModelId ?? requestModel
    if (isText(route)) tags.push(`trajectory.gateway.route:${tagValue(route)}`)
    const destination = routing && destinationId(routing)
    if (destination) tags.push(`trajectory.gateway.destination.id:${tagValue(destination)}`)
    if (this.#clientSourceTag) tags.push(this.#clientSourceTag)

    const client = this.#getClient()
    const attempt = [PROVIDER_ATTEMPT_PROFILE, ...tags]

    const durationTags = call.error === undefined ? attempt : [...attempt, `error.type:${errorType(call.error)}`]
    client.distribution('gen_ai.client.inference.duration', call.durationSeconds, durationTags)
    client.increment('gen_ai.client.inference.duration.sum', call.durationSeconds, durationTags)
    client.increment('gen_ai.client.inference.duration.count', 1, durationTags)

    // Input tokens include cache reads and writes, and output tokens include reasoning, whichever way the provider
    // and SDK version report them.
    const { inputTokens, outputTokens, cacheReadTokens, cacheWrites } = normalizeUsage(call.usage, {
      providerMetadata: metadata,
      provider: providerSlug,
      model: routing?.originalModelId ?? requestModel,
    })
    const tokenTags = [...attempt, UNKNOWN_MODALITY]
    if (inputTokens !== undefined) {
      client.increment('gen_ai.client.inference.usage.input_tokens', inputTokens, tokenTags)
    }
    if (outputTokens !== undefined) {
      client.increment('gen_ai.client.inference.usage.output_tokens', outputTokens, tokenTags)
    }

    // The breakdown profile needs both totals. The AI SDK reports zero cache tokens for calls that used no prompt
    // cache, so a zero is treated as not observed.
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const breakdown = [TOKEN_BREAKDOWN_PROFILE, ...tags, UNKNOWN_MODALITY]
      if (cacheReadTokens) {
        client.increment('gen_ai.client.inference.usage.cache_read.input_tokens', cacheReadTokens, breakdown)
      }
      for (const { lifetime, tokens } of cacheWrites) {
        client.increment(
          'gen_ai.client.inference.usage.cache_write.input_tokens',
          tokens,
          [...breakdown, `trajectory.cache.lifetime:${lifetime}`]
        )
      }
    }

    const cost = reportedCost(gateway?.cost)
    if (cost !== undefined) {
      client.increment(
        'trajectory.gen_ai.client.inference.usage.cost',
        cost,
        [...attempt, 'trajectory.cost.source:reported']
      )
    }
  }

  #getClient () {
    if (this.#client) return this.#client

    // Only the profile's own tags: the global tracer tags (service, env, version) would multiply the series, as in
    // dd-trace-py, where they are opt-in.
    const clientConfig = { ...DogStatsDClient.generateClientConfig(this.#config), tags: [] }
    const client = new MetricsAggregationClient(new DogStatsDClient(clientConfig))
    this.#client = client

    setInterval(() => client.flush(), FLUSH_INTERVAL_MS).unref?.()
    globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers.add(() => client.flush())

    return client
  }
}

/**
 * The recorder for one AI SDK plugin, or `undefined` when `DD_AI_SDK_USAGE_METRICS_ENABLED` is off.
 *
 * @param {import('../../../config/config-base')} config
 * @returns {GatewayUsageMetrics | undefined}
 */
function createGatewayUsageMetrics (config) {
  if (!config.ai?.DD_AI_SDK_USAGE_METRICS_ENABLED) return
  return new GatewayUsageMetrics(config)
}

module.exports = {
  createGatewayUsageMetrics,
  isGatewayProvider,
}
