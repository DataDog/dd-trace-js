'use strict'

const pluginManager = require('../../../../../..')._pluginManager
const log = require('../../../log')
const { storage: llmobsStorage } = require('../../storage')
const LLMObsTagger = require('../../tagger')
const LLMObsPlugin = require('../base')
const { joinStreamChunks, streamInputToChatMessages, streamInputToPrompt } = require('./stream')

const ANTHROPIC_PROVIDER_NAME = 'anthropic'
const BEDROCK_PROVIDER_NAME = 'amazon_bedrock'
const OPENAI_PROVIDER_NAME = 'openai'

// Providers that ship their own LLMObs integration. When one of these is also
// enabled, the LangChain model span is demoted to `workflow` so the provider
// integration emits the single `llm` span — avoiding two llm spans (and
// double-counted tokens/cost) for one underlying call.
const SUPPORTED_INTEGRATIONS = new Set(['openai', 'anthropic'])
const LLM_SPAN_TYPES = new Set(['llm', 'chat_model', 'embedding'])
const LLM = 'llm'
const WORKFLOW = 'workflow'
const EMBEDDING = 'embedding'
const TOOL = 'tool'
const RETRIEVAL = 'retrieval'
const TASK = 'task'

const ChainHandler = require('./handlers/chain')
const ChatModelHandler = require('./handlers/chat_model')
const LlmHandler = require('./handlers/llm')
const EmbeddingHandler = require('./handlers/embedding')
const ToolHandler = require('./handlers/tool')
const VectorStoreHandler = require('./handlers/vectorstore')

/**
 * @param {LLMObsPlugin} plugin
 * @returns {typeof BaseLangChainLLMObsPlugin}
 */
function pluginClass (plugin) {
  return /** @type {typeof BaseLangChainLLMObsPlugin} */ (plugin.constructor)
}

class BaseLangChainLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langchain'
  static id = 'langchain'
  static prefix = 'tracing:apm:langchain:invoke'
  /** @type {string | undefined} langchain operation type (one of chain, chat_model, llm, embedding, tool, ...) */
  static lcType

  constructor () {
    super(...arguments)

    this._handlers = {
      chain: new ChainHandler(this._tagger),
      chat_model: new ChatModelHandler(this._tagger),
      llm: new LlmHandler(this._tagger),
      embedding: new EmbeddingHandler(this._tagger),
      tool: new ToolHandler(this._tagger),
      similarity_search: new VectorStoreHandler(this._tagger),
    }
  }

  error (ctx) {
    // NodeInterrupt or GraphInterrupt "errors" for control flow, do not mark as real errors
    if (ctx.error?.is_bubble_up) return

    super.error(ctx)
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const spanContext = span?.context()
    const tags = spanContext?.getTags() || {}

    const modelProvider = tags['langchain.request.provider'] // could be undefined
    const modelName = tags['langchain.request.model'] // could be undefined
    const instance = ctx.instance || ctx.self
    const kind = this.getKind(ctx.type, modelProvider, instance)

    const handler = this._handlers[ctx.type]
    const name = handler?.getName({ span, instance, options: ctx.arguments?.[1] })

    if (name == null) return

    return {
      modelProvider,
      modelName,
      kind,
      name,
      integration: kind === TASK ? 'langgraph' : pluginClass(this).integration,
    }
  }

  setLLMObsTags (ctx) {
    ctx.args = ctx.arguments
    ctx.instance = ctx.self

    const span = ctx.currentStore?.span
    const type = ctx.type = pluginClass(this).lcType

    if (!type || !Object.keys(this._handlers).includes(type)) {
      log.warn('Unsupported LangChain operation type:', type)
      return
    }

    const provider = span?.context()?.getTag('langchain.request.provider')
    const integrationName = this.getIntegrationName(type, provider)
    this.setMetadata(span, provider, ctx.instance)

    const inputs = ctx.args?.[0]
    const options = ctx.args?.[1]
    const results = ctx.result

    this._handlers[type].setMetaTags({ span, inputs, results, options, integrationName, instance: ctx.instance })
  }

  /**
   * Tags `temperature` and `max_tokens` from the model instance (mirrors Python's `_identifying_params` scan).
   *
   * @param {import('../../../opentracing/span')} span
   * @param {string | undefined} provider
   * @param {Record<string, unknown> | undefined} instance
   */
  setMetadata (span, provider, instance) {
    if (!provider || !instance) return

    /** @type {{ temperature?: number, max_tokens?: number } | undefined} */
    let metadata
    const modelKwargs = /** @type {Record<string, unknown> | undefined} */ (
      instance.modelKwargs ?? instance.model_kwargs
    )

    const temperature = Number(instance.temperature ?? modelKwargs?.temperature ?? NaN)
    const maxTokens = Number(
      instance.maxTokens ?? instance.max_tokens ??
      instance.maxCompletionTokens ?? instance.max_completion_tokens ??
      modelKwargs?.max_tokens ?? modelKwargs?.max_completion_tokens ?? NaN
    )

    if (!Number.isNaN(temperature)) metadata = { temperature }

    if (!Number.isNaN(maxTokens)) {
      metadata ??= {}
      metadata.max_tokens = maxTokens
    }

    if (metadata) this._tagger.tagMetadata(span, metadata)
  }

  getKind (type, provider, instance) {
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
      case 'chain':
        return this._handlers.chain.isLangGraphNode(instance) ? TASK : WORKFLOW
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
  static id = 'llmobs_langchain_rs_invoke'
  static lcType = 'chain'
  static prefix = 'tracing:orchestrion:@langchain/core:RunnableSequence_invoke'
}

class RunnableSequenceBatchPlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_rs_batch'
  static lcType = 'chain'
  static prefix = 'tracing:orchestrion:@langchain/core:RunnableSequence_batch'
}

class BaseChatModelGeneratePlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_chat_model_generate'
  static lcType = 'chat_model'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseChatModel_generate'
}

class BaseLLMGeneratePlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_llm_generate'
  static lcType = 'llm'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseLLM_generate'
}

class EmbeddingsEmbedQueryPlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_embeddings_embed_query'
  static lcType = 'embedding'
  static prefix = 'tracing:orchestrion:@langchain/core:Embeddings_embedQuery'
}

class EmbeddingsEmbedDocumentsPlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_embeddings_embed_documents'
  static lcType = 'embedding'
  static prefix = 'tracing:orchestrion:@langchain/core:Embeddings_embedDocuments'
}

class ToolInvokePlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_tool_invoke'
  static lcType = 'tool'
  static prefix = 'tracing:orchestrion:@langchain/core:Tool_invoke'
}

class VectorStoreSimilaritySearchPlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_vectorstore_similarity_search'
  static lcType = 'similarity_search'
  static prefix = 'tracing:orchestrion:@langchain/core:VectorStore_similaritySearch'
}

class VectorStoreSimilaritySearchWithScorePlugin extends BaseLangChainLLMObsPlugin {
  static id = 'llmobs_langchain_vectorstore_similarity_search_with_score'
  static lcType = 'similarity_search'
  static prefix = 'tracing:orchestrion:@langchain/core:VectorStore_similaritySearchWithScore'
}

// Streaming: the span is registered when `_streamIterator` is called and the stream input/chunks are
// kept on the shared channel context until the matching `:next` plugin sees the last chunk.
class BaseLangChainStreamLLMObsPlugin extends BaseLangChainLLMObsPlugin {
  getLLMObsSpanRegisterOptions (ctx) {
    const registerOptions = super.getLLMObsSpanRegisterOptions(ctx)
    if (registerOptions) {
      ctx.langchainStream = { inputs: ctx.arguments?.[0], options: ctx.arguments?.[1], chunks: [] }
    }
    return registerOptions
  }

  asyncEnd () {}
}

class BaseLangChainStreamNextLLMObsPlugin extends BaseLangChainLLMObsPlugin {
  // Re-activate the LLMObs span while the generator body runs so nested provider spans are parented to it.
  start (ctx) {
    const span = ctx.currentStore?.span
    if (!span || !LLMObsTagger.tagMap.has(span)) return

    const parentStore = llmobsStorage.getStore()
    ctx.llmobs = { parent: parentStore }
    llmobsStorage.enterWith({ ...parentStore, span })
  }

  // The APM plugin finishes the span on `error`, before `asyncEnd`, so the stream must be finalized here.
  error (ctx) {
    super.error(ctx)

    const streamData = ctx.langchainStream
    const span = ctx.currentStore?.span
    if (!streamData || !span) return

    ctx.langchainStream = undefined
    this.#finalize(ctx, span, streamData)
  }

  setLLMObsTags (ctx) {
    const streamData = ctx.langchainStream
    const span = ctx.currentStore?.span
    if (!streamData || !span) return

    if (ctx.result?.done === false && ctx.method !== 'return') {
      streamData.chunks.push(ctx.result.value)
      return
    }

    if (ctx.result?.done !== true && ctx.method !== 'return') return

    ctx.langchainStream = undefined
    this.#finalize(ctx, span, streamData)
  }

  /**
   * @param {{ self?: Record<string, unknown> }} ctx
   * @param {import('../../../opentracing/span')} span
   * @param {{ inputs: unknown, options: unknown, chunks: Array<string | import('./stream').StreamChunk> }} streamData
   */
  #finalize (ctx, span, streamData) {
    const type = pluginClass(this).lcType
    const provider = /** @type {string | undefined} */ (span.context()?.getTag('langchain.request.provider'))
    const integrationName = this.getIntegrationName(type, provider)
    this.setMetadata(span, provider, ctx.self)

    const joined = joinStreamChunks(streamData.chunks)
    const streamInputs = /** @type {string | unknown[] | import('./stream').PromptValueLike | undefined} */ (
      streamData.inputs
    )
    let inputs = streamData.inputs
    /** @type {unknown} */
    let results = joined

    switch (type) {
      case 'chat_model': {
        inputs = streamInputToChatMessages(streamInputs)
        const text = typeof joined === 'string' ? joined : joined?.content ?? ''
        results = { generations: [[{ message: joined ?? {}, text }]] }
        break
      }
      case 'llm':
        inputs = streamInputToPrompt(streamInputs)
        results = { generations: [[{ text: joined ?? '' }]] }
        break
    }

    this._handlers[type].setMetaTags({
      span,
      inputs,
      results,
      options: streamData.options,
      integrationName,
      instance: ctx.self,
    })
  }
}

class BaseChatModelStreamPlugin extends BaseLangChainStreamLLMObsPlugin {
  static id = 'llmobs_langchain_chat_model_stream'
  static lcType = 'chat_model'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseChatModel_streamIterator'
}

class BaseChatModelStreamNextPlugin extends BaseLangChainStreamNextLLMObsPlugin {
  static id = 'llmobs_langchain_chat_model_stream_next'
  static lcType = 'chat_model'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseChatModel_streamIterator:next'
}

class BaseLLMStreamPlugin extends BaseLangChainStreamLLMObsPlugin {
  static id = 'llmobs_langchain_llm_stream'
  static lcType = 'llm'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseLLM_streamIterator'
}

class BaseLLMStreamNextPlugin extends BaseLangChainStreamNextLLMObsPlugin {
  static id = 'llmobs_langchain_llm_stream_next'
  static lcType = 'llm'
  static prefix = 'tracing:orchestrion:@langchain/core:BaseLLM_streamIterator:next'
}

class RunnableSequenceStreamPlugin extends BaseLangChainStreamLLMObsPlugin {
  static id = 'llmobs_langchain_rs_stream'
  static lcType = 'chain'
  static prefix = 'tracing:orchestrion:@langchain/core:RunnableSequence_streamIterator'
}

class RunnableSequenceStreamNextPlugin extends BaseLangChainStreamNextLLMObsPlugin {
  static id = 'llmobs_langchain_rs_stream_next'
  static lcType = 'chain'
  static prefix = 'tracing:orchestrion:@langchain/core:RunnableSequence_streamIterator:next'
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
  VectorStoreSimilaritySearchWithScorePlugin,
  BaseChatModelStreamPlugin,
  BaseChatModelStreamNextPlugin,
  BaseLLMStreamPlugin,
  BaseLLMStreamNextPlugin,
  RunnableSequenceStreamPlugin,
  RunnableSequenceStreamNextPlugin,
]
