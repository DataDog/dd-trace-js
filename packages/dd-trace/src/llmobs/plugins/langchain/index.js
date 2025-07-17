'use strict'

const log = require('../../../log')
const LLMObsPlugin = require('../base')

const pluginManager = require('../../../../../..')._pluginManager

const ANTHROPIC_PROVIDER_NAME = 'anthropic'
const BEDROCK_PROVIDER_NAME = 'amazon_bedrock'
const OPENAI_PROVIDER_NAME = 'openai'

const SUPPORTED_INTEGRATIONS = new Set(['openai'])
const LLM_SPAN_TYPES = new Set(['llm', 'chat_model', 'embedding'])
const LLM = 'llm'
const WORKFLOW = 'workflow'
const EMBEDDING = 'embedding'
const TOOL = 'tool'
const RETRIEVAL = 'retrieval'

const ChainHandler = require('./handlers/chain')
const ChatModelHandler = require('./handlers/chat_model')
const LlmHandler = require('./handlers/llm')
const EmbeddingHandler = require('./handlers/embedding')
const ToolHandler = require('./handlers/tool')
const VectorStoreHandler = require('./handlers/vectorstore')

class BaseLangChainLLMObsPlugin extends LLMObsPlugin {
  static get integration () { return 'langchain' }
  static get id () { return 'langchain' }
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

  constructor () {
    super(...arguments)

    this._handlers = {
      chain: new ChainHandler(this._tagger),
      chat_model: new ChatModelHandler(this._tagger),
      llm: new LlmHandler(this._tagger),
      embedding: new EmbeddingHandler(this._tagger),
      tool: new ToolHandler(this._tagger),
      similarity_search: new VectorStoreHandler(this._tagger)
    }
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const tags = span?.context()._tags || {}

    const modelProvider = tags['langchain.request.provider'] // could be undefined
    const modelName = tags['langchain.request.model'] // could be undefined
    const kind = this.getKind(ctx.type, modelProvider)

    const instance = ctx.instance || ctx.self
    const handler = this._handlers[ctx.type]
    const name = handler?.getName({ span, instance })

    return {
      modelProvider,
      modelName,
      kind,
      name
    }
  }

  setLLMObsTags (ctx) {
    ctx.args = ctx.arguments
    ctx.instance = ctx.self

    const span = ctx.currentStore?.span
    const type = ctx.type = this.constructor.lcType // langchain operation type (oneof chain,chat_model,llm,embedding)

    if (!Object.keys(this._handlers).includes(type)) {
      log.warn('Unsupported LangChain operation type:', type)
      return
    }

    const provider = span?.context()._tags['langchain.request.provider']
    const integrationName = this.getIntegrationName(type, provider)
    this.setMetadata(span, provider)

    const inputs = ctx.args?.[0]
    const options = ctx.args?.[1]
    const results = ctx.result

    this._handlers[type].setMetaTags({ span, inputs, results, options, integrationName })
  }

  setMetadata (span, provider) {
    if (!provider) return

    const metadata = {}

    // these fields won't be set for non model-based operations
    const temperature =
      span?.context()._tags[`langchain.request.${provider}.parameters.temperature`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.temperature`]

    const maxTokens =
      span?.context()._tags[`langchain.request.${provider}.parameters.max_tokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.maxTokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.max_tokens`]

    if (temperature) {
      metadata.temperature = Number.parseFloat(temperature)
    }

    if (maxTokens) {
      metadata.maxTokens = Number.parseInt(maxTokens)
    }

    this._tagger.tagMetadata(span, metadata)
  }

  getKind (type, provider) {
    if (LLM_SPAN_TYPES.has(type)) {
      const llmobsIntegration = this.getIntegrationName(type, provider)

      if (!this.isLLMIntegrationEnabled(llmobsIntegration)) {
        return type === 'embedding' ? EMBEDDING : LLM
      }
    }

    switch (type) {
      case 'tool':
        return TOOL
      case 'similarity_search':
        return RETRIEVAL
      default:
        return WORKFLOW
    }
  }

  getIntegrationName (type, provider = 'custom') {
    if (provider.startsWith(BEDROCK_PROVIDER_NAME)) {
      return 'bedrock'
    } else if (provider.startsWith(OPENAI_PROVIDER_NAME)) {
      return 'openai'
    } else if (type === 'chat_model' && provider.startsWith(ANTHROPIC_PROVIDER_NAME)) {
      return 'anthropic'
    }

    return provider
  }

  isLLMIntegrationEnabled (integration) {
    return SUPPORTED_INTEGRATIONS.has(integration) && pluginManager?._pluginsByName[integration]?.llmobs?._enabled
  }
}

class RunnableSequenceInvokePlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_rs_invoke' }
  static get lcType () { return 'chain' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:RunnableSequence_invoke'
  }
}

class RunnableSequenceBatchPlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_rs_batch' }
  static get lcType () { return 'chain' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:RunnableSequence_batch'
  }
}

class BaseChatModelGeneratePlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_chat_model_generate' }
  static get lcType () { return 'chat_model' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:BaseChatModel_generate'
  }
}

class BaseLLMGeneratePlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_llm_generate' }
  static get lcType () { return 'llm' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:BaseLLM_generate'
  }
}

class EmbeddingsEmbedQueryPlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_embeddings_embed_query' }
  static get lcType () { return 'embedding' }
  static get prefix () {
    return 'tracing:apm:@langchain/core:Embeddings_embedQuery'
  }
}

class EmbeddingsEmbedDocumentsPlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_embeddings_embed_documents' }
  static get lcType () { return 'embedding' }
  static get prefix () {
    return 'tracing:apm:@langchain/core:Embeddings_embedDocuments'
  }
}

class ToolInvokePlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_tool_invoke' }
  static get lcType () { return 'tool' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:Tool_invoke'
  }
}

class VectorStoreSimilaritySearchPlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_vectorstore_similarity_search' }
  static get lcType () { return 'similarity_search' }
  static get prefix () {
    return 'tracing:orchestrion:@langchain/core:VectorStore_similaritySearch'
  }
}

class VectorStoreSimilaritySearchWithScorePlugin extends BaseLangChainLLMObsPlugin {
  static get id () { return 'llmobs_langchain_vectorstore_similarity_search_with_score' }
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
