'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent } = require('./utils')

class GraphQLValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'validate'

  bindStart (ctx) {
    const { docSource, document } = ctx
    const source = this.config.source && document && docSource

    this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': source
      }
    }, ctx)

    return ctx.currentStore
  }

  finish (ctx) {
    const { document, errors } = ctx
    const span = ctx?.currentStore?.span || this.activeSpan
    this.config.hooks.validate(span, document, errors)
    if (errors) {
      for (const err of errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }
    super.finish(ctx)

    return ctx.parentStore
  }
}

module.exports = GraphQLValidatePlugin
