'use strict'

const LLMObsPlugin = require('../base')
const LLMObsTagger = require('../../tagger')
const { spanHasError, safeJsonParse } = require('../../util')

const streamDataMap = new WeakMap()
const SUPPORTED_INTEGRATIONS = new Set(['openai'])

function isIterator (value) {
  return value != null && typeof value.next === 'function'
}

function textContent (value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    let text = ''
    for (const part of value) {
      if (part?.type === 'text') text += part.text ?? ''
    }
    return text
  }
  if (value && typeof value === 'object') return value.text ?? value.content ?? ''
  return value == null ? '' : String(value)
}

function queryText (value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (typeof value.query === 'string') return value.query
    if (value.query && typeof value.query === 'object') return queryText(value.query)
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
  }
  return value == null ? '' : String(value)
}

function inputMessages (messages) {
  return (Array.isArray(messages) ? messages : []).map(message => ({
    role: message?.role ?? '',
    content: textContent(message?.content),
  }))
}

function getUsage (raw) {
  const values = Array.isArray(raw) ? raw : [raw]
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i]?.usage) return values[i].usage
  }
}

function metricsFromUsage (usage) {
  if (!usage) return
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens
  const outputTokens = usage.completion_tokens ?? usage.output_tokens
  const totalTokens = usage.total_tokens ?? (
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : null
  )
  const metrics = {}
  if (inputTokens !== undefined) metrics.inputTokens = inputTokens
  if (outputTokens !== undefined) metrics.outputTokens = outputTokens
  if (totalTokens !== null) metrics.totalTokens = totalTokens
  return metrics
}

function isProviderWorkflow (plugin, liType, provider) {
  return (liType === 'llm' || liType === 'embedding') &&
    provider === 'openai' &&
    plugin.isLLMIntegrationEnabled('openai')
}

function toolCalls (value) {
  const calls = Array.isArray(value) ? value : [value]
  return calls.map(toolCall => ({
    name: toolCall.name,
    arguments: typeof toolCall.input === 'string' ? safeJsonParse(toolCall.input) : toolCall.input,
    toolId: toolCall.id,
  }))
}

function outputMessage (message) {
  const output = {
    role: message?.role ?? 'assistant',
    content: textContent(message?.content),
  }
  const toolCall = message?.options?.toolCall
  if (toolCall) output.toolCalls = toolCalls(toolCall)
  return output
}

class BaseLlamaIndexLLMObsPlugin extends LLMObsPlugin {
  static integration = 'llamaindex'

  getLLMObsSpanRegisterOptions (ctx) {
    const plugin = /** @type {Function & {liType?: string, methodName?: string}} */ (this.constructor)
    const span = ctx.currentStore?.span
    const tags = span?.context()?.getTags() || {}
    const modelProvider = tags['llamaindex.request.provider']
    const modelName = tags['llamaindex.request.model']
    const liType = plugin.liType
    let kind = {
      llm: 'llm',
      embedding: 'embedding',
      retrieval: 'retrieval',
      query: 'workflow',
      chat: 'workflow',
      synthesize: 'task',
    }[liType]

    if (isProviderWorkflow(this, liType, modelProvider)) kind = 'workflow'

    if (span && liType === 'llm') {
      streamDataMap.set(span, {
        input: ctx.arguments?.[0],
        chunks: [],
      })
    }

    const options = {
      kind,
      name: span?.context()?.getTag('resource.name'),
    }
    if (liType === 'llm' || liType === 'embedding') {
      options.modelName = modelName
      options.modelProvider = modelProvider
    }
    return options
  }

  asyncEnd (ctx) {
    // streaming llm spans are tagged by NextStreamLLMObsPlugin once the iterator completes
    const plugin = /** @type {Function & {liType?: string}} */ (this.constructor)
    if (plugin.liType === 'llm' && isIterator(ctx.result)) return
    super.asyncEnd(ctx)
  }

  setLLMObsTags (ctx) {
    const plugin = /** @type {Function & {liType?: string, methodName?: string}} */ (this.constructor)
    const span = ctx.currentStore?.span
    if (!span) return
    const liType = plugin.liType
    const provider = span.context().getTag('llamaindex.request.provider')
    const workflow = isProviderWorkflow(this, liType, provider)

    if (liType === 'llm') {
      const input = inputMessages(ctx.arguments?.[0]?.messages)
      if (spanHasError(span)) {
        return workflow
          ? this._tagger.tagTextIO(span, JSON.stringify(input), '')
          : this._tagger.tagLLMIO(span, input, [{ content: '' }])
      }
      const output = [outputMessage(ctx.result?.message)]
      const usage = getUsage(ctx.result?.raw)
      if (workflow) this._tagger.tagTextIO(span, JSON.stringify(input), output[0].content)
      else this._tagger.tagLLMIO(span, input, output)
      const metrics = metricsFromUsage(usage)
      if (metrics) this._tagger.tagMetrics(span, metrics)
      const metadata = {}
      if (ctx.self?.temperature !== undefined) metadata.temperature = ctx.self.temperature
      if (ctx.self?.maxTokens !== undefined) metadata.max_tokens = ctx.self.maxTokens
      if (metadata.temperature !== undefined || metadata.max_tokens !== undefined) {
        this._tagger.tagMetadata(span, metadata)
      }
      return
    }

    if (liType === 'embedding') {
      const texts = plugin.methodName === 'getQueryEmbedding'
        ? [queryText(ctx.arguments?.[0])]
        : (ctx.arguments?.[0] || []).map(queryText)
      const input = texts.map(text => ({ text }))
      if (spanHasError(span)) return this._tagger.tagEmbeddingIO(span, input, '')
      const vector = ctx.result
      const count = plugin.methodName === 'getQueryEmbedding' ? 1 : texts.length
      const dimension = plugin.methodName === 'getQueryEmbedding'
        ? vector?.length ?? 0
        : vector?.[0]?.length ?? 0
      const output = `[${count} embedding(s) returned with size ${dimension}]`
      if (workflow) this._tagger.tagTextIO(span, JSON.stringify(input), output)
      else this._tagger.tagEmbeddingIO(span, input, output)
      return
    }

    if (liType === 'retrieval') {
      const input = queryText(ctx.arguments?.[0]?.query ?? ctx.arguments?.[0])
      const documents = (ctx.result || []).map(item => {
        const document = { text: item?.node?.getContent?.() ?? item?.node?.text ?? '' }
        if (typeof item?.score === 'number') document.score = item.score
        if (item?.node?.id_ !== undefined) document.id = item.node.id_
        return document
      })
      this._tagger.tagRetrievalIO(span, input, spanHasError(span) ? [] : documents)
      return
    }

    const input = liType === 'chat'
      ? textContent(ctx.arguments?.[0]?.message)
      : queryText(ctx.arguments?.[0]?.query ?? ctx.arguments?.[0])
    if (isIterator(ctx.result)) return
    const output = spanHasError(span) ? '' : ctx.result?.response ?? ctx.result?.message?.content ?? ''
    this._tagger.tagTextIO(span, input, output)
  }

  isLLMIntegrationEnabled (integration) {
    const pluginManager = require('../../../../../..')._pluginManager
    return SUPPORTED_INTEGRATIONS.has(integration) && pluginManager?._pluginsByName[integration]?.llmobs?._enabled
  }
}

class NextStreamLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_llamaindex_next_stream'
  static integration = 'llamaindex'
  static prefix = 'tracing:orchestrion:@llamaindex/core:LLM_chat:next'

  start () {}
  end () {}

  error (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    this.tagStream(span, true)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const data = streamDataMap.get(span)
    if (!span || !data) return
    if (ctx.result?.value && !ctx.result.done) {
      data.chunks.push(ctx.result.value)
      data.usage = getUsage(ctx.result.value?.raw) || data.usage
      return
    }
    if (ctx.result?.done) this.tagStream(span, spanHasError(span))
  }

  tagStream (span, error) {
    const data = streamDataMap.get(span)
    if (!data) return
    const input = inputMessages(data.input?.messages)
    let content = ''
    let toolCall
    for (const chunk of data.chunks) {
      content += chunk?.delta ?? ''
      toolCall = chunk?.options?.toolCall || toolCall
    }
    const message = {
      role: 'assistant',
      content: error ? '' : content,
    }
    if (toolCall) {
      message.toolCalls = toolCalls(toolCall)
    }
    const workflow = LLMObsTagger.getSpanKind(span) === 'workflow'
    if (workflow) this._tagger.tagTextIO(span, JSON.stringify(input), message.content)
    else this._tagger.tagLLMIO(span, input, [message])
    const metrics = metricsFromUsage(data.usage)
    if (metrics) this._tagger.tagMetrics(span, metrics)
    streamDataMap.delete(span)
  }
}

const definitions = [
  ['LLM_chat', 'llm', 'chat'],
  ['BaseEmbedding_getQueryEmbedding', 'embedding', 'getQueryEmbedding'],
  ['BaseEmbedding_getTextEmbeddingsBatch', 'embedding', 'getTextEmbeddingsBatch'],
  ['BaseRetriever_retrieve', 'retrieval', 'retrieve'],
  ['BaseQueryEngine_query', 'query', 'query'],
  ['ContextChatEngine_chat', 'chat', 'chat'],
  ['SimpleChatEngine_chat', 'chat', 'chat'],
  ['BaseSynthesizer_synthesize', 'synthesize', 'synthesize'],
]

const plugins = definitions.map(([channel, liType, methodName]) => {
  return class extends BaseLlamaIndexLLMObsPlugin {
    static id = `llmobs_llamaindex_${channel.toLowerCase()}`
    static prefix = `tracing:orchestrion:@llamaindex/core:${channel}`
    static liType = liType
    static methodName = methodName
  }
})

module.exports = [...plugins, NextStreamLLMObsPlugin]
