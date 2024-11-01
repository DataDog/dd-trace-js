'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const handlers = require('./handlers')

const API_KEY = 'langchain.request.api_key'
const MODEL = 'langchain.request.model'
const PROVIDER = 'langchain.request.provider'
const TYPE = 'langchain.request.type'

class LangChainPlugin extends TracingPlugin {
  static get id () { return 'langchain' }
  static get operation () { return 'invoke' }
  static get system () { return 'langchain' }
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

  bindStart (ctx) {
    const { resource, type } = ctx
    const handler = getHandler(type)

    const instance = ctx.instance
    const apiKey = handler.extractApiKey?.(ctx) || extractApiKey(instance)
    const provider = handler.extractProvider?.(ctx) || extractProvider(instance)
    const model = extractModel(instance)

    const tags = handler.getStartTags(ctx, provider) || []

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
    const store = storage.getStore() || {}

    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx.currentStore.span

    const { type } = ctx

    const handler = getHandler(type)
    const tags = handler.getEndTags(ctx) || {}

    span.addTags(tags)

    span.finish()
  }
}

function getHandler (type) {
  const handlerGetter = handlers[type] || handlers.default
  return handlerGetter()
}

function extractApiKey (instance) {
  const key = Object.keys(instance)
    .filter(key => key.includes('apiKey') || key.includes('apiToken')) // TODO: double check this
    .find(key => {
      let apiKey = instance[key]
      if (!apiKey) return false
      if (apiKey.getSecretValue && typeof apiKey.getSecretValue === 'function') {
        apiKey = apiKey.getSecretValue()
      }

      if (typeof apiKey !== 'string') return false

      return true
    })

  const apiKey = instance[key]
  if (!apiKey || apiKey.length < 4) return ''
  return `...${apiKey.slice(-4)}`
}

function extractProvider (instance) {
  // TODO: we might just be able to do `instance._llmType()`
  return typeof instance._llmType === 'function' && instance._llmType().split('-')[0]
}

function extractModel (instance) {
  for (const attr of ['model', 'modelName', 'modelId', 'modelKey', 'repoId']) {
    const modelName = instance[attr]
    if (modelName) return modelName
  }
}

module.exports = LangChainPlugin
