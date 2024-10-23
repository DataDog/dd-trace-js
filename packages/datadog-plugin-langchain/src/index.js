'use strict'

const { MEASURED } = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const handlers = require('./handlers')

class LangChainPlugin extends TracingPlugin {
  static get id () { return 'langchain' }
  static get operation () { return 'invoke' }
  static get system () { return 'langchain' }
  static get prefix () {
    return 'tracing:apm:langchain:invoke'
  }

  bindStart (ctx) {
    const { resource, type } = ctx
    const tags = handlers[type]().getStartTags(ctx)

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

    span.finish()
  }
}

module.exports = LangChainPlugin
