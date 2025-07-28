'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const MODEL = 'langchain.request.model'
const PROVIDER = 'langchain.request.provider'
const TYPE = 'langchain.request.type'

const LangChainHandler = require('./handlers/default')
const LangChainLanguageModelHandler = require('./handlers/language_models')
const LangChainEmbeddingHandler = require('./handlers/embedding')

class BaseLangChainTracingPlugin extends TracingPlugin {
  static get id () { return 'langchain' }
  static get operation () { return 'invoke' }
  static get system () { return 'langchain' }

  constructor () {
    super(...arguments)

    this.handlers = {
      chain: new LangChainHandler(this._tracerConfig),
      chat_model: new LangChainLanguageModelHandler(this._tracerConfig),
      llm: new LangChainLanguageModelHandler(this._tracerConfig),
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

    const resourceParts = [...ns, ctx.self.constructor.name]
    if (type === 'tool') {
      resourceParts.push(ctx.instance.name)
    }
    const resource = ctx.resource = resourceParts.join('.')

    const handler = this.handlers[type] || this.handlers.default

    const instance = ctx.instance
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

    const tags = {}

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

class ToolInvokePlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_tool_invoke' }
  static get lcType () { return 'tool' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:Tool_invoke'
  }
}

class VectorStoreSimilaritySearchPlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_vectorstore_similarity_search' }
  static get lcType () { return 'similarity_search' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:VectorStore_similaritySearch'
  }
}

class VectorStoreSimilaritySearchWithScorePlugin extends BaseLangChainTracingPlugin {
  static get id () { return 'langchain_vectorstore_similarity_search_with_score' }
  static get lcType () { return 'similarity_search' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:VectorStore_similaritySearchWithScore'
  }
}

module.exports = [
  RunnableSequenceInvokePlugin,
  RunnableSequenceBatchPlugin,
  BaseChatModelGeneratePlugin,
  BaseLLMGeneratePlugin,
  EmbeddingsEmbedQueryPlugin,
  EmbeddingsEmbedDocumentsPlugin,
  ToolInvokePlugin,
  VectorStoreSimilaritySearchPlugin,
  VectorStoreSimilaritySearchWithScorePlugin
]
