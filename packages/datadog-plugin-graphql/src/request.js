'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent, isApolloHealthCheckSource } = require('./utils')

/**
 * @typedef {object} GraphQLRequestStore
 * @property {import('../../dd-trace/src/opentracing/span')} [span]
 * @property {import('../../dd-trace/src/opentracing/span')} [graphqlRequestSpan]
 * @property {string} [graphqlRequestOperationName]
 */

/**
 * @typedef {object} GraphQLRequestContext
 * @property {unknown[]} [arguments]
 * @property {GraphQLRequestStore} [currentStore]
 * @property {GraphQLRequestStore} [parentStore]
 * @property {boolean} [ddSkipped]
 * @property {{ errors?: import('graphql').GraphQLError[] }} [result]
 */

// Top-level GraphQL request span for drivers that funnel every operation
// through a single entry point but parse/validate/execute internally (mercurius
// today). It parents the `graphql.parse`/`graphql.validate`/`graphql.execute`
// sub-spans and carries the request text + operation name/type.
//
// The entry boundary only hands us the raw `source` (string or pre-parsed AST)
// and `operationName`; the parsed document — and therefore the precise
// operation signature — is only known at validate on the cold path or at
// graphql-jit execute on the warm path.
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

    // `source` is the request text on the common path, but mercurius also
    // accepts a pre-parsed document AST; only a string is the query text, and
    // `graphql.source` carries only the text form.
    const docSource = typeof source === 'string' ? source : undefined

    const span = this.startSpan(this.operationName({ id: 'request' }), {
      service: this.config.service || this.serviceName(),
      resource: operationName || undefined,
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.name': operationName,
        'graphql.source': this.config.source ? docSource : undefined,
      },
    }, ctx)

    // The first downstream boundary with a parsed document refines the resource
    // and operation tags without parsing the source again.
    ctx.currentStore.graphqlRequestSpan = span
    ctx.currentStore.graphqlRequestOperationName = operationName

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
