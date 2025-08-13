'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const services = require('./services')
const { MEASURED } = require('../../../ext/tags')
const { DD_MAJOR } = require('../../../version')

class AnthropicTracingPlugin extends TracingPlugin {
  static id = 'anthropic'
  static operation = 'request'
  static system = 'anthropic'
  static prefix = 'tracing:apm:anthropic:request'

  constructor (...args) {
    super(...args)

    const { metrics, logger } = services.init(this._tracerConfig)
    this.metrics = metrics
    this.logger = logger

    this.addSub('apm:anthropic:request:chunk', ({ ctx, chunk, done }) => {
      if (!ctx.chunks) ctx.chunks = []
      
      if (chunk) ctx.chunks.push(chunk)
      if (!done) return

      const chunks = ctx.chunks
      if (chunks.length === 0) return

      // Construct complete response from streamed chunks
      const response = this.constructResponseFromChunks(chunks)
      ctx.result = { data: response }
    })
  }

  configure (config) {
    if (config.enabled === false) {
      services.shutdown()
    }

    super.configure(config)
  }

  bindStart (ctx) {
    const { methodName, args } = ctx
    const payload = normalizeRequestPayload(methodName, args)
    const normalizedMethodName = normalizeMethodName(methodName)

    const store = storage('legacy').getStore() || {}
    store.originalMethodName = methodName
    store.normalizedMethodName = normalizedMethodName

    const span = this.startSpan('anthropic.request', {
      service: this.config.service,
      resource: DD_MAJOR >= 6 ? normalizedMethodName : methodName,
      type: 'anthropic',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        'anthropic.request.model': payload.model
      }
    }, false)

    const anthropicStore = Object.create(null)
    const tags = {}

    if (payload.stream) {
      tags['anthropic.request.stream'] = payload.stream
    }

    if (normalizedMethodName === 'createMessage') {
      createMessageRequestExtraction(tags, payload, anthropicStore)
    }

    span.addTags(tags)
    ctx.currentStore = { ...store, span, anthropic: anthropicStore }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const { result } = ctx
    const store = ctx.currentStore

    const span = store?.span
    if (!span) return

    const error = !!span.context()._tags.error

    let headers, body, method, path
    if (!error) {
      headers = result.headers
      body = result.data
      method = result.request?.method
      path = result.request?.path
    }

    if (!error && headers?.constructor.name === 'Headers') {
      headers = Object.fromEntries(headers)
    }

    const normalizedMethodName = store.normalizedMethodName
    const anthropicStore = store.anthropic

    const tags = error
      ? {}
      : {
          'anthropic.request.endpoint': '/v1/messages',
          'anthropic.request.method': method ? method.toUpperCase() : 'POST',
          'anthropic.response.model': body.model,
          'anthropic.response.id': body.id,
          'anthropic.response.type': body.type,
          'anthropic.response.role': body.role,
          'anthropic.response.stop_reason': body.stop_reason
        }

    if (!error) {
      responseDataExtractionByMethod(normalizedMethodName, tags, body, anthropicStore)
    }

    span.addTags(tags)
    span.finish()

    this.sendLog(normalizedMethodName, span, tags, anthropicStore, error)
    this.sendMetrics(headers, body, span._duration, error, tags)
  }

  sendMetrics (headers, body, duration, error, spanTags) {
    const tags = [`error:${Number(!!error)}`]
    
    if (error) {
      this.metrics.increment('anthropic.request.error', 1, tags)
    } else {
      tags.push(
        `endpoint:/v1/messages`,
        `model:${body.model}`
      )
    }

    this.metrics.distribution('anthropic.request.duration', duration * 1000, tags)

    const inputTokens = spanTags['anthropic.response.usage.input_tokens']
    const outputTokens = spanTags['anthropic.response.usage.output_tokens']

    if (!error) {
      if (inputTokens != null) {
        this.metrics.distribution('anthropic.tokens.input', inputTokens, tags)
      }

      if (outputTokens != null) {
        this.metrics.distribution('anthropic.tokens.output', outputTokens, tags)
      }
    }
  }

  sendLog (operation, span, tags, anthropicStore, error) {
    if (error || !this.logger) return
    
    const log = {
      timestamp: new Date().toISOString(),
      operation,
      span_id: span.context().toSpanId(),
      trace_id: span.context().toTraceId(),
      ...tags
    }

    this.logger.info(JSON.stringify(log))
  }

  constructResponseFromChunks (chunks) {
    // Basic implementation for streaming response reconstruction
    let content = ''
    let model = null
    let id = null

    for (const chunk of chunks) {
      if (chunk.content && chunk.content[0] && chunk.content[0].text) {
        content += chunk.content[0].text
      }
      if (!model && chunk.model) model = chunk.model
      if (!id && chunk.id) id = chunk.id
    }

    return {
      id,
      model,
      content: [{ text: content }],
      role: 'assistant',
      type: 'message'
    }
  }
}

function normalizeMethodName (methodName) {
  if (methodName === 'messages.create') {
    return 'createMessage'
  }
  return methodName
}

function normalizeRequestPayload (methodName, args) {
  return args[0] || {}
}

function createMessageRequestExtraction (tags, payload, anthropicStore) {
  if (payload.max_tokens) {
    tags['anthropic.request.max_tokens'] = payload.max_tokens
  }

  if (payload.temperature !== undefined) {
    tags['anthropic.request.temperature'] = payload.temperature
  }

  if (payload.messages && Array.isArray(payload.messages)) {
    tags['anthropic.request.messages.count'] = payload.messages.length
  }

  anthropicStore.requestPayload = payload
}

function responseDataExtractionByMethod (normalizedMethodName, tags, body, anthropicStore) {
  if (normalizedMethodName === 'createMessage' && body) {
    if (body.usage) {
      tags['anthropic.response.usage.input_tokens'] = body.usage.input_tokens
      tags['anthropic.response.usage.output_tokens'] = body.usage.output_tokens
    }

    if (body.content && Array.isArray(body.content) && body.content[0]) {
      const textContent = body.content.find(c => c.type === 'text')
      if (textContent) {
        tags['anthropic.response.content.length'] = textContent.text ? textContent.text.length : 0
      }
    }
  }
}

module.exports = AnthropicTracingPlugin