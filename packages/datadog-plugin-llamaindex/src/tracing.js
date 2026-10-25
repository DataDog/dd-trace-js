'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { spanHasError } = require('../../dd-trace/src/llmobs/util')

const TYPE = 'llamaindex.request.type'
const MODEL = 'llamaindex.request.model'
const PROVIDER = 'llamaindex.request.provider'

function isIterator (result) {
  return result != null && typeof result.next === 'function'
}

class BaseLlamaIndexTracingPlugin extends TracingPlugin {
  static id = 'llamaindex'
  static operation = 'invoke'

  bindStart (ctx) {
    const plugin = /** @type {Function & {liType?: string, methodName?: string}} */ (this.constructor)
    const methodName = plugin.methodName
    const self = ctx.self
    const provider = self?.constructor?.name?.toLowerCase()?.replace(/embedding$/, '')
    const model = self?.model ?? self?.metadata?.model
    const span = this.startSpan('llamaindex.request', {
      service: this.config.service,
      resource: `${self?.constructor?.name}.${methodName}`,
      kind: 'client',
      meta: { [MEASURED]: 1 },
    }, false)

    const tags = { [TYPE]: plugin.liType }
    if (model !== undefined) tags[MODEL] = model
    if (provider !== undefined) tags[PROVIDER] = provider
    span.addTags(tags)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const plugin = /** @type {Function & {liType?: string}} */ (this.constructor)
    if (plugin.liType === 'llm' && isIterator(ctx.result)) return
    this.finish(ctx)
  }
}

class NextStreamPlugin extends TracingPlugin {
  static id = 'llamaindex_stream_next'
  static prefix = 'tracing:orchestrion:@llamaindex/core:LLM_chat:next'

  bindStart (ctx) {
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    if (ctx.result?.done === true || spanHasError(span)) span.finish()
  }
}

const definitions = [
  ['LLM_chat', 'llm'],
  ['BaseEmbedding_getQueryEmbedding', 'embedding'],
  ['BaseEmbedding_getTextEmbeddingsBatch', 'embedding'],
  ['BaseRetriever_retrieve', 'retrieval'],
  ['BaseQueryEngine_query', 'query'],
  ['ContextChatEngine_chat', 'chat'],
  ['SimpleChatEngine_chat', 'chat'],
  ['BaseSynthesizer_synthesize', 'synthesize'],
]

const plugins = definitions.map(([channel, liType]) => {
  return class extends BaseLlamaIndexTracingPlugin {
    static id = `llamaindex_${channel.toLowerCase()}`
    static prefix = `tracing:orchestrion:@llamaindex/core:${channel}`
    static methodName = channel === 'LLM_chat' ? 'chat' : channel.split('_').at(-1)
    static liType = liType
  }
})

module.exports = [...plugins, NextStreamPlugin]
