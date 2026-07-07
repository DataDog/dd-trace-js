'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent, refineRequestSpan } = require('./utils')

const legacyStorage = storage('legacy')

class GraphQLValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'validate'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:validate'

  bindStart (ctx) {
    // validate(schema, documentAST, rules, options, typeInfo)
    const document = ctx.arguments?.[1]
    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const source = this.config.source && document && docSource

    // Refine the top-level graphql.request span (mercurius) from the parsed
    // document. validate is the first boundary that has it and precedes both
    // execute and any pre-execute rejection (unknown field, GET mutation), so a
    // failing request still ends up with a resource and operation tags. The
    // request span and its operation name ride the active store the request
    // boundary entered (validate's own `ctx.currentStore` is not populated
    // yet). No-op for graphql-js/apollo/yoga, which never open a request span.
    const requestStore = legacyStorage.getStore()
    refineRequestSpan(
      requestStore?.graphqlRequestSpan,
      document,
      docSource,
      requestStore?.graphqlRequestOperationName,
      this.config.signature
    )

    this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': source,
      },
    }, ctx)

    ctx.ddDocument = document

    return ctx.currentStore
  }

  end (ctx) {
    const document = ctx.ddDocument
    const errors = ctx.result
    const span = ctx?.currentStore?.span || this.activeSpan

    this.config.hooks.validate(span, document, errors)

    if (errors?.length) {
      span.setTag('error', errors[0])
      for (const err of errors) {
        extractErrorIntoSpanEvent(this.config, span, err)
      }
    }

    span.finish()

    return ctx.parentStore
  }
}

module.exports = GraphQLValidatePlugin
