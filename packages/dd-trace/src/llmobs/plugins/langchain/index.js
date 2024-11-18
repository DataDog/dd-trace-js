'use strict'

const log = require('../../../log')
const LLMObsPlugin = require('../base')

const pluginManager = require('../../../../../..')._pluginManager

const ANTHROPIC_PROVIDER_NAME = 'anthropic'
const BEDROCK_PROVIDER_NAME = 'amazon_bedrock'
const OPENAI_PROVIDER_NAME = 'openai'

const SUPPORTED_INTEGRATIONS = ['openai']
const LLM_SPAN_TYPES = ['llm', 'chat_model', 'embedding']
const LLM = 'llm'
const WORKFLOW = 'workflow'
const EMBEDDING = 'embedding'

const ChainHandler = require('./handlers/chain')
const ChatModelHandler = require('./handlers/chat_model')
const LlmHandler = require('./handlers/llm')
const EmbeddingHandler = require('./handlers/embedding')

const SUPPORTED_HANLDERS = {
  chain: ChainHandler,
  chat_model: ChatModelHandler,
  llm: LlmHandler,
  embedding: EmbeddingHandler
}

class LangChainLLMObsPlugin extends LLMObsPlugin {
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

  constructor () {
    super(...arguments)

    this._handlers =
      Object.entries(SUPPORTED_HANLDERS)
        .reduce((acc, [type, Handler]) => {
          acc[type] = new Handler(this._tagger)
          return acc
        }, {})
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const tags = span?.context()._tags || {}

    const modelProvider = tags['langchain.request.provider'] // could be undefined
    const modelName = tags['langchain.request.model'] // could be undefined
    const kind = this.getKind(ctx.type, modelProvider)
    const name = tags['resource.name']

    return {
      modelProvider,
      modelName,
      kind,
      name
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    const type = ctx.type // langchain operation type

    if (!Object.keys(SUPPORTED_HANLDERS).includes(type)) {
      log.warn(`Unsupported LangChain operation type: ${type}`)
      return
    }

    const provider = span?.context()._tags['langchain.request.provider']
    const integrationName = this.getIntegrationName(type, provider)
    this._setMetadata(span, provider)

    const inputs = ctx.args?.[0]
    const options = ctx.args?.[1]
    const results = ctx.result

    this._handlers[type].setMetaTags({ span, inputs, results, options, integrationName })
  }

  _setMetadata (span, provider) {
    if (!provider) return

    const metadata = {}

    const temperature =
      span?.context()._tags[`langchain.request.${provider}.parameters.temperature`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.temperature`]

    const maxTokens =
      span?.context()._tags[`langchain.request.${provider}.parameters.max_tokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.maxTokens`] ||
      span?.context()._tags[`langchain.request.${provider}.parameters.model_kwargs.max_tokens`]

    if (temperature) {
      metadata.temperature = parseFloat(temperature)
    }

    if (maxTokens) {
      metadata.maxTokens = parseInt(maxTokens)
    }

    this._tagger.tagMetadata(span, metadata)
  }

  getKind (type, provider) {
    if (LLM_SPAN_TYPES.includes(type)) {
      const llmobsIntegration = this.getIntegrationName(type, provider)

      if (!this.isLLMIntegrationEnabled(llmobsIntegration)) {
        return type === 'embedding' ? EMBEDDING : LLM
      }
    }

    return WORKFLOW
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
    return SUPPORTED_INTEGRATIONS.includes(integration) && pluginManager?._pluginsByName[integration]?.llmobs?._enabled
  }
}

module.exports = LangChainLLMObsPlugin
