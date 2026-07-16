'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { isApolloHealthCheckSource } = require('./utils')

const documentSources = new WeakMap()

// Documents produced by parsing an Apollo Gateway health-check poll. Populated
// here (parse owns the document lifecycle, like documentSources) and read by the
// validate plugin. Execute independently verifies the operation for cached docs.
const healthCheckDocuments = new WeakSet()

class GraphQLParsePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'parser'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:parser'

  bindStart (ctx) {
    const source = ctx.arguments?.[0]

    // Apollo Gateway polls every subgraph with a fixed health-check query.
    // Mark its document after parsing so validation can skip the same poll.
    if (isApolloHealthCheckSource(source?.body ?? source)) {
      ctx.ddHealthCheck = true
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {},
    }, ctx)

    ctx.ddSource = source

    return ctx.currentStore
  }

  end (ctx) {
    const document = ctx.result

    if (ctx.ddHealthCheck) {
      if (document) healthCheckDocuments.add(document)
      return ctx.parentStore
    }

    const source = ctx.ddSource
    const span = ctx?.currentStore?.span || this.activeSpan

    let docSource
    if (document) {
      if (source) {
        docSource = source.body || source
        documentSources.set(document, docSource)
      } else {
        docSource = documentSources.get(document)
      }
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
GraphQLParsePlugin.healthCheckDocuments = healthCheckDocuments

module.exports = GraphQLParsePlugin
