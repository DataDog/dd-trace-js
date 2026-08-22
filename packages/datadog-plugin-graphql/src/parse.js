'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { isApolloHealthCheckSource, subscribeToPrefix } = require('./utils')

const legacyStorage = storage('legacy')

const documentSources = new WeakMap()

// Documents produced by parsing an Apollo Gateway health-check poll. Populated
// here (parse owns the document lifecycle, like documentSources) and read by the
// validate plugin. Execute independently verifies the operation for cached docs.
const healthCheckDocuments = new WeakSet()

class GraphQLParsePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'parser'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:parser'

  // graphql-js >=17's own native `graphql:parse` diagnostics_channel (see utils.js'
  // `subscribeToPrefix` doc comment for why this is needed alongside orchestrion).
  static extraPrefixes = ['tracing:graphql:parse']

  addTraceSubs () {
    super.addTraceSubs()

    for (const prefix of this.constructor.extraPrefixes) {
      subscribeToPrefix(this, prefix)
    }
  }

  bindStart (ctx) {
    // The native channel's context has no `.arguments` (that's an orchestrion-only
    // convention) and carries `source` directly instead of positional arguments.
    const native = ctx.arguments === undefined
    const source = native ? ctx.source : ctx.arguments[0]

    if (native) {
      ctx.parentStore = ctx.currentStore = legacyStorage.getStore()
    }

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
