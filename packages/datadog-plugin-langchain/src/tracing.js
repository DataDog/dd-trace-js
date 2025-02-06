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

class LangChainTracingPlugin extends TracingPlugin {
  static get id () { return 'langchain' }
  static get operation () { return 'invoke' }
  static get system () { return 'langchain' }
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

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
    const { resource, type } = ctx
    const handler = this.handlers[type]

    const instance = ctx.instance
    const apiKey = handler.extractApiKey(instance)
    const provider = handler.extractProvider(instance)
    const model = handler.extractModel(instance)

    const tags = handler.getSpanStartTags(ctx, provider) || []

    if (apiKey) tags[API_KEY] = apiKey
    if (provider) tags[PROVIDER] = provider
    if (model) tags[MODEL] = model
    if (type) tags[TYPE] = type

    const span = this.startSpan('langchain.request', {
      service: this.config.service,
      resource,
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        ...tags
      }
    }, false)

    const store = storage('legacy').getStore() || {}
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span

    const { type } = ctx

    const handler = this.handlers[type]
    const tags = handler.getSpanEndTags(ctx) || {}

    span.addTags(tags)

    span.finish()
  }

  getHandler (type) {
    return this.handlers[type] || this.handlers.default
  }
}

module.exports = LangChainTracingPlugin
