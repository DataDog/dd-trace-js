'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const documentSources = new WeakMap()

class GraphQLParsePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'parser'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:parser'

  bindStart (ctx) {
    const source = ctx.arguments?.[0]

    this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {},
    }, ctx)

    ctx.ddSource = source

    return ctx.currentStore
  }

  end (ctx) {
    const source = ctx.ddSource
    const document = ctx.result
    const span = ctx?.currentStore?.span || this.activeSpan

    let docSource
    if (source && document) {
      docSource = source.body || source
      documentSources.set(document, docSource)
    } else if (document) {
      docSource = documentSources.get(document)
    }

    if (this.config.source && docSource) {
      span.setTag('graphql.source', docSource)
    }

    this.config.hooks.parse(span, source, document)

    span.finish()

    return ctx.parentStore
  }
}

GraphQLParsePlugin.documentSources = documentSources

module.exports = GraphQLParsePlugin
