'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const { extractErrorIntoSpanEvent, isApolloHealthCheck, refineRequestSpan } = require('./utils')

/** @typedef {import('../../dd-trace/src/opentracing/span')} DatadogSpan */

const legacyStorage = storage('legacy')

class GraphQLValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'validate'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:validate'

  /** @param {object} ctx */
  bindStart (ctx) {
    // validate(schema, documentAST, rules, options, typeInfo)
    const document = ctx.arguments?.[1]

    // Verify the marked document in case the caller transformed its AST after parsing.
    if (document &&
        GraphQLParsePlugin.healthCheckDocuments.has(document) &&
        document.definitions?.length === 1 &&
        isApolloHealthCheck(document.definitions[0])) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const docSource = document ? GraphQLParsePlugin.documentSources.get(document) : undefined
    const source = this.config.source && document && docSource

    // Validation precedes execute and pre-execute rejection, so it is the cold
    // path's first opportunity to label the enclosing mercurius request span.
    const requestStore =
      /** @type {{ graphqlRequestSpan?: DatadogSpan, graphqlRequestOperationName?: string } | undefined} */ (
        legacyStorage.getStore()
      )
    refineRequestSpan(
      requestStore?.graphqlRequestSpan,
      document,
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

    if (errors?.length) {
      span.setTag('error', errors[0])
      for (const err of errors) {
        extractErrorIntoSpanEvent(this.config, span, err)
      }
    }

    this.config.hooks.validate(span, document, errors)

    span.finish()

    return ctx.parentStore
  }
}

module.exports = GraphQLValidatePlugin
