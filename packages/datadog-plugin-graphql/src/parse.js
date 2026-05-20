'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

// WeakMap to cache document → source mappings for cross-plugin access
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

    // Stash source on ctx for use in end handler
    ctx._ddSource = source

    return ctx.currentStore
  }

  end (ctx) {
    const source = ctx._ddSource
    const document = ctx.result
    const span = ctx?.currentStore?.span || this.activeSpan

    // Cache document → source for other plugins (execute, validate)
    if (source && document) {
      const body = source.body || source
      documentSources.set(document, body)
    }

    const docSource = document ? documentSources.get(document) : undefined

    if (this.config.source && document && docSource) {
      span.setTag('graphql.source', docSource)
    }

    this.config.hooks.parse(span, source, document)

    span?.finish()

    return ctx.parentStore
  }
}

GraphQLParsePlugin.documentSources = documentSources

module.exports = GraphQLParsePlugin
