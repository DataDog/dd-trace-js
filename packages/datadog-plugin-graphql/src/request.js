'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const {
  extractErrorIntoSpanEvent,
  getCachedRequestOperation,
  getRequestCache,
  isApolloHealthCheckSource,
} = require('./utils')

/** @typedef {ReturnType<typeof getRequestCache>} RequestCache */

/**
 * @typedef {object} GraphQLRequestStore
 * @property {import('../../dd-trace/src/opentracing/span')} [span]
 * @property {import('../../dd-trace/src/opentracing/span')} [graphqlRequestSpan]
 * @property {RequestCache} [graphqlRequestCache]
 * @property {string} [graphqlRequestOperationName]
 * @property {unknown} [graphqlRequestSource]
 */

/**
 * @typedef {object} GraphQLRequestContext
 * @property {unknown[]} [arguments]
 * @property {GraphQLRequestStore} [currentStore]
 * @property {GraphQLRequestStore} [parentStore]
 * @property {boolean} [ddSkipped]
 * @property {boolean | number} [ddCacheLimit]
 * @property {{ errors?: import('graphql').GraphQLError[] }} [result]
 * @property {object} [self]
 */

// Top-level GraphQL request span for drivers that funnel every operation
// through a single entry point but parse/validate/execute internally (mercurius
// today). It parents the `graphql.parse`/`graphql.validate`/`graphql.execute`
// (or JIT) sub-spans and carries the request text + operation name/type, which
// otherwise have no home if GraphQL-JIT instrumentation is unavailable.
//
// The entry boundary only hands us the raw `source` (string or pre-parsed AST)
// and `operationName`; the parsed document — and therefore the precise
// operation signature — is only known once mercurius parses internally. On the
// cold path the `validate` sub-plugin refines the resource/operation tags onto
// this span via `ctx.currentStore.graphqlRequestSpan` once the document is
// available. The normal and JIT execute plugins use the same refinement path
// when present. A bounded cache preserves the metadata when a warm JIT query
// skips validation and GraphQL-JIT instrumentation is unavailable or disabled.
class GraphQLRequestPlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'request'
  static type = 'graphql'
  static kind = 'server'
  static prefix = 'tracing:orchestrion:mercurius:apm:graphql:request'

  /**
   * @param {GraphQLRequestContext} ctx
   */
  bindStart (ctx) {
    // fastifyGraphQl(source, context, variables, operationName)
    const source = ctx.arguments?.[0]

    if (isApolloHealthCheckSource(source)) {
      ctx.ddSkipped = true
      return ctx.currentStore
    }

    const operationName = ctx.arguments?.[3]
    const requestCache = getRequestCache(ctx.self, ctx.ddCacheLimit)

    const docSource = typeof source === 'string' ? source : undefined
    const cached = getCachedRequestOperation(source, operationName, this.config.signature, requestCache)

    const span = this.startSpan(this.operationName({ id: 'request' }), {
      service: this.config.service || this.serviceName(),
      resource: cached?.signature || operationName || undefined,
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.type': cached?.type,
        'graphql.operation.name': cached?.name || operationName,
        'graphql.source': this.config.source ? docSource : undefined,
      },
    }, ctx)

    ctx.currentStore.graphqlRequestSpan = span
    ctx.currentStore.graphqlRequestCache = requestCache
    ctx.currentStore.graphqlRequestOperationName = operationName
    ctx.currentStore.graphqlRequestSource = source

    return ctx.currentStore
  }

  /**
   * @param {GraphQLRequestContext} ctx
   */
  asyncEnd (ctx) {
    if (ctx.ddSkipped) return ctx.parentStore

    /* istanbul ignore next: currentStore is populated for the request lifecycle; activeSpan is base-plugin fallback. */
    const span = ctx?.currentStore?.span || this.activeSpan
    /* istanbul ignore if: startSpan always populates currentStore for the request lifecycle. */
    if (!span) return ctx.parentStore

    const result = ctx.result
    if (result?.errors?.length) {
      span.setTag('error', result.errors[0])
      for (const error of result.errors) {
        extractErrorIntoSpanEvent(this.config, span, error)
      }
    }

    span.finish()

    return ctx.parentStore
  }

  error (ctx) {
    /* istanbul ignore next: currentStore is populated for request errors; activeSpan is base-plugin fallback. */
    const span = ctx?.currentStore?.span || this.activeSpan
    /* istanbul ignore else: errors are only routed after the request span has started. */
    if (span && ctx?.error) {
      span.setTag('error', ctx.error)
    }
  }
}

module.exports = GraphQLRequestPlugin
