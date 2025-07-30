'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class GraphQLParsePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'parser' }

  bindStart (ctx) {
    this.startSpan('graphql.parse', {
      service: this.config.service,
      type: 'graphql',
      meta: {}
    }, ctx)

    return ctx.currentStore
  }

  finish (ctx) {
    const { source, document, docSource } = ctx
    const span = ctx?.currentStore?.span || this.activeSpan

    if (this.config.source && document) {
      span.setTag('graphql.source', docSource)
    }

    this.config.hooks.parse(span, source, document)

    super.finish(ctx)

    return ctx.parentStore
  }
}

module.exports = GraphQLParsePlugin
