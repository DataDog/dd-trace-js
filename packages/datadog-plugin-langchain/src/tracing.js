'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const API_KEY = 'langchain.request.api_key'
const MODEL = 'langchain.request.model'
const PROVIDER = 'langchain.request.provider'
const TYPE = 'langchain.request.type'

const LangChainHandler = require('./handlers/default')
const LangChainChatModelHandler = require('./handlers/language_models/chat_model')
const LangChainLLMHandler = require('./handlers/language_models/llm')
const LangChainChainHandler = require('./handlers/chain')
const LangChainEmbeddingHandler = require('./handlers/embedding')

class BaseLangChainTracingPlugin extends TracingPlugin {
  static get id () { return 'langchain' }
  static get operation () { return 'invoke' }
  static get system () { return 'langchain' }

  constructor () {
    super(...arguments)

    this.handlers = {
      chain: new LangChainChainHandler(this._tracerConfig),
      chat_model: new LangChainChatModelHandler(this._tracerConfig),
      llm: new LangChainLLMHandler(this._tracerConfig),
      embedding: new LangChainEmbeddingHandler(this._tracerConfig),
      default: new LangChainHandler(this._tracerConfig)
    }
  }

  bindStart (ctx) {
    // TODO(bengl): All this renaming is just so we don't have to change the existing handlers
    ctx.args = ctx.arguments
    ctx.instance = ctx.self
    const type = ctx.type = this.constructor.lcType

    // Runnable interfaces have an `lc_namespace` property
    const ns = ctx.self.lc_namespace || ctx.namespace
    const resource = ctx.resource = [...ns, ctx.self.constructor.name].join('.')

    const handler = this.handlers[type]

    const instance = ctx.instance
    const apiKey = handler.extractApiKey(instance)
    const provider = handler.extractProvider(instance)
    const model = handler.extractModel(instance)

    const span = this.startSpan('langchain.request', {
      service: this.config.service,
      resource,
      kind: 'client',
      meta: {
        [MEASURED]: 1
      }
    }, false)

    const tags = handler.getSpanStartTags(ctx, provider, span) || []

    if (apiKey) tags[API_KEY] = apiKey
    if (provider) tags[PROVIDER] = provider
    if (model) tags[MODEL] = model
    if (type) tags[TYPE] = type

    span.addTags(tags)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span

    const { type } = ctx

    const handler = this.handlers[type]
    const tags = handler.getSpanEndTags(ctx, span) || {}

    span.addTags(tags)

    span.finish()
  }

  getHandler (type) {
    return this.handlers[type] || this.handlers.default
  }
}

class RunnableSequenceInvokePlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_rs_invoke' }
  static get lcType () { return 'chain' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:RunnableSequence_invoke'
  }
}

class RunnableSequenceBatchPlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_rs_batch' }
  static get lcType () { return 'chain' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:RunnableSequence_batch'
  }
}

class BaseChatModelGeneratePlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_chat_model_generate' }
  static get lcType () { return 'chat_model' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:BaseChatModel_generate'
  }
}

class BaseLLMGeneratePlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_llm_generate' }
  static get lcType () { return 'llm' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:BaseLLM_generate'
  }
}

class EmbeddingsEmbedQueryPlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_embeddings_embed_query' }
  static get lcType () { return 'embedding' }
  static get prefix () {
    return 'tracing:apm:@langchain/core:Embeddings_embedQuery'
  }
}

class EmbeddingsEmbedDocumentsPlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_embeddings_embed_documents' }
  static get lcType () { return 'embedding' }
  static get prefix () {
    return 'tracing:apm:@langchain/core:Embeddings_embedDocuments'
  }
}

module.exports = [
  RunnableSequenceInvokePlugin,
  RunnableSequenceBatchPlugin,
  BaseChatModelGeneratePlugin,
  BaseLLMGeneratePlugin,
  EmbeddingsEmbedQueryPlugin,
  EmbeddingsEmbedDocumentsPlugin
]
