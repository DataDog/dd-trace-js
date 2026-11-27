'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { isApolloHealthCheckSource, usesNativeDiagnostics } = require('./utils')

const legacyStorage = storage('legacy')
const pendingParses = new WeakMap()
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
    const args = ctx.arguments
    const source = args ? args[0] : ctx.source
    if (!args) {
      const store = legacyStorage.getStore()
      const span = store?.span
      if (pendingParses.get(span) === source && pendingParses.delete(span)) {
        ctx.ddSkipped = true
        return store
      }
    }

    // Apollo Gateway polls every subgraph with a fixed health-check query.
    // Mark its document after parsing so validation can skip the same poll.
    if (isApolloHealthCheckSource(source?.body ?? source)) {
      ctx.ddHealthCheck = true
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const span = this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {},
    }, ctx)

    if (args && usesNativeDiagnostics(ctx.moduleVersion)) {
      pendingParses.set(span, source)
      ctx.ddNativePublisher = true
    }
    ctx.ddSource = source

    return ctx.currentStore
  }

  /** @param {Parameters<TracingPlugin['error']>[0] & { ddSkipped?: boolean }} ctx */
  error (ctx) {
    if (!ctx.ddSkipped) super.error(ctx)
  }

  end (ctx) {
    const document = ctx.result

    if (ctx.ddSkipped) {
      if (ctx.ddHealthCheck && document) healthCheckDocuments.add(document)
      return ctx.parentStore
    }

    const source = ctx.ddSource
    const span = ctx?.currentStore?.span || this.activeSpan

    if (ctx.ddNativePublisher) {
      pendingParses.delete(span)
    }

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
