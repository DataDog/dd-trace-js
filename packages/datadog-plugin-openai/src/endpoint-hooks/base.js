'use strict'

const TracingPlugin = require('../../../dd-trace/src/plugins/tracing')
const { storage } = require('../../../datadog-core')
const Sampler = require('../../../dd-trace/src/sampler')
const { MEASURED } = require('../../../../ext/tags')

// let normalize

// const { DD_MAJOR } = require('../../../../version')

class OpenAiBaseEndpointHook extends TracingPlugin {
  static get operation () { return 'request' }
  static get system () { return 'openai' }

  constructor (services, utilities, ...args) {
    super(...args)

    const { metrics, logger } = services
    this.metrics = metrics
    this.logger = logger

    const { normalize } = utilities
    this.normalize = normalize

    this.sampler = new Sampler(0.1) // default 10% log sampling
  }

  bindStart (ctx) {
    const payloadTags = this.getPayloadTags(ctx)
    const resource = this.getResource(ctx)

    const span = this.startSpan('openai.request', {
      service: this.config.service,
      resource,
      type: 'openai',
      kind: 'client',
      meta: {
        ...payloadTags,
        [MEASURED]: 1
      }
    }, false)

    const inputTags = this.getInputTags(ctx)
    span.addTags(inputTags)

    const store = storage('legacy').getStore()
    const openaiStore = Object.create(null)
    ctx.currentStore = { ...store, span, openai: openaiStore }

    return ctx.currentStore
  }

  end (ctx) { // sync because the promise types are custom for openai
    const span = ctx.currentStore?.span
    if (!span) return

    const { result } = ctx
    // instead of wrapping the result, queue up a separate promise to handle when the response resolves
    // since we want the response headers as well, call `withResponse()` to get that
    // while this makes it easier to manage on our side as opposed to wrapping, it does queue up another promise
    result.withResponse().then(({ data, response }) => {
      // handle the response - assume it is not a stream at this point

      const responseTags = this.getResponseTags(ctx)
      span.addTags(responseTags)

      span.finish()
      // this.sendLog(resource, span, tags, openaiStore, error)
      // this.sendMetrics(headers, body, endpoint, span._duration, error, tags)
    })
  }

  getResource (ctx) {}

  getPayloadTags (ctx) {}

  getInputTags (ctx) {}

  getResponseTags (ctx) {}

  sendMetrics (headers, body, endpoint, duration, error, spanTags) {
    const tags = [`error:${Number(!!error)}`]
    if (error) {
      this.metrics.increment('openai.request.error', 1, tags)
    } else {
      tags.push(`org:${headers['openai-organization']}`)
      tags.push(`endpoint:${endpoint}`) // just "/v1/models", no method
      tags.push(`model:${headers['openai-model'] || body.model}`)
    }

    this.metrics.distribution('openai.request.duration', duration * 1000, tags)

    const promptTokens = spanTags['openai.response.usage.prompt_tokens']
    const promptTokensEstimated = spanTags['openai.response.usage.prompt_tokens_estimated']

    const completionTokens = spanTags['openai.response.usage.completion_tokens']
    const completionTokensEstimated = spanTags['openai.response.usage.completion_tokens_estimated']

    const totalTokens = spanTags['openai.response.usage.total_tokens']

    if (!error) {
      if (promptTokens != null) {
        if (promptTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.prompt', promptTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.prompt', promptTokens, tags)
        }
      }

      if (completionTokens != null) {
        if (completionTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.completion', completionTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.completion', completionTokens, tags)
        }
      }

      if (totalTokens != null) {
        if (promptTokensEstimated || completionTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.total', totalTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.total', totalTokens, tags)
        }
      }
    }

    if (headers) {
      if (headers['x-ratelimit-limit-requests']) {
        this.metrics.gauge('openai.ratelimit.requests', Number(headers['x-ratelimit-limit-requests']), tags)
      }

      if (headers['x-ratelimit-remaining-requests']) {
        this.metrics.gauge(
          'openai.ratelimit.remaining.requests', Number(headers['x-ratelimit-remaining-requests']), tags
        )
      }

      if (headers['x-ratelimit-limit-tokens']) {
        this.metrics.gauge('openai.ratelimit.tokens', Number(headers['x-ratelimit-limit-tokens']), tags)
      }

      if (headers['x-ratelimit-remaining-tokens']) {
        this.metrics.gauge('openai.ratelimit.remaining.tokens', Number(headers['x-ratelimit-remaining-tokens']), tags)
      }
    }
  }

  sendLog (methodName, span, tags, openaiStore, error) {
    if (!openaiStore) return
    if (!Object.keys(openaiStore).length) return
    if (!this.sampler.isSampled()) return

    const log = {
      status: error ? 'error' : 'info',
      message: `sampled ${methodName}`,
      ...openaiStore
    }

    this.logger.log(log, span, tags)
  }
}

// function truncateApiKey (apiKey) {
//   return apiKey && `sk-...${apiKey.substr(apiKey.length - 4)}`
// }

module.exports = OpenAiBaseEndpointHook
