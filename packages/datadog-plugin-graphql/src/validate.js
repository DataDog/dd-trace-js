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

    // The parse plugin marks documents parsed from an Apollo health-check poll;
    // skip validation's span so the poll produces no graphql spans.
    if (document && GraphQLParsePlugin.healthCheckDocuments.has(document)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const source = this.config.source && document && docSource

    // Refine the top-level graphql.request span (mercurius) from the parsed
    // document. validate is the first boundary that has it and precedes both
    // execute and any pre-execute rejection (unknown field, GET mutation), so a
    // failing request still ends up with a resource and operation tags. The
    // request span, its operation name, and the raw source ride the active
    // store the request boundary entered (validate's own `ctx.currentStore` is
    // not populated yet). The cache is keyed by that raw source, not the parsed
    // document — for a pre-parsed AST mercurius validates a structuredClone, so
    // the document here is a different object from the one the boundary saw and
    // recovers on the warm path. No-op for graphql-js/apollo/yoga, which never
    // open a request span.
    const requestStore = legacyStorage.getStore()
    refineRequestSpan(
      requestStore?.graphqlRequestSpan,
      document,
      requestStore?.graphqlRequestSource,
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
    if (ctx.ddSkipped) return ctx.parentStore

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
