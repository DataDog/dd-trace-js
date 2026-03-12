'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent } = require('./utils')

class GraphQLValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'validate'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:validate'

  bindStart (ctx) {
    // validate(schema, documentAST, rules, options, typeInfo)
    const document = ctx.arguments?.[1]
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const source = this.config.source && document && docSource

    this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': source,
      },
    }, ctx)

    // Stash for end handler
    ctx._ddDocument = document

    return ctx.currentStore
  }

  end (ctx) {
    const document = ctx._ddDocument
    const errors = ctx.result
    const span = ctx?.currentStore?.span || this.activeSpan

    this.config.hooks.validate(span, document, errors)

    if (errors && errors.length) {
      // Set error tag on span (first error sets the main error)
      span.setTag('error', errors[0])
      for (const err of errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }

    span?.finish()

    return ctx.parentStore
  }
}

module.exports = GraphQLValidatePlugin
