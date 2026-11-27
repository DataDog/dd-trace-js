'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const GraphQLParsePlugin = require('./parse')
const {
  extractErrorIntoSpanEvent,
  isApolloHealthCheck,
  refineRequestSpan,
  usesNativeDiagnostics,
} = require('./utils')

const legacyStorage = storage('legacy')
const pendingValidations = new WeakMap()

class GraphQLValidatePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'validate'
  static prefix = 'tracing:orchestrion:graphql:apm:graphql:validate'

  bindStart (ctx) {
    // validate(schema, documentAST, rules, options, typeInfo)
    const args = ctx.arguments
    const document = args ? args[1] : ctx.document
    if (!args) {
      const store = legacyStorage.getStore()
      const span = store?.span
      const pending = pendingValidations.get(span)
      if (pending && pending[0] === ctx.schema && pending[1] === document) {
        pendingValidations.delete(span)
        ctx.ddSkipped = true
        return store
      }
    }

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

    const span = this.startSpan('graphql.validate', {
      service: this.config.service,
      type: 'graphql',
      meta: {
        'graphql.source': source,
      },
    }, ctx)

    if (args && usesNativeDiagnostics(ctx.moduleVersion)) {
      pendingValidations.set(span, args)
      ctx.ddNativePublisher = true
    }
    ctx.ddDocument = document

    return ctx.currentStore
  }

  /** @param {Parameters<TracingPlugin['error']>[0] & { ddSkipped?: boolean }} ctx */
  error (ctx) {
    if (!ctx.ddSkipped) super.error(ctx)
  }

  end (ctx) {
    if (ctx.ddSkipped) return ctx.parentStore

    const document = ctx.ddDocument
    const errors = ctx.result
    const span = ctx?.currentStore?.span || this.activeSpan

    if (ctx.ddNativePublisher) {
      pendingValidations.delete(span)
    }

    refineRequestSpan(
      ctx.currentStore?.graphqlRequestSpan,
      document,
      ctx.currentStore?.graphqlRequestSource,
      ctx.currentStore?.graphqlRequestOperationName,
      this.config.signature,
      !errors?.length,
      ctx.currentStore?.graphqlRequestCache
    )

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
