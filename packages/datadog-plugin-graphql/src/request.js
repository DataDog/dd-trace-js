'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent, getCachedRequestOperation } = require('./utils')

// Top-level GraphQL request span for drivers that funnel every operation
// through a single entry point but parse/validate/execute internally (mercurius
// today). It parents the `graphql.parse`/`graphql.validate`/`graphql.execute`
// (or JIT) sub-spans and carries the request text + operation name/type, which
// otherwise have no home when the query is JIT-compiled and `graphql.execute`
// never fires.
//
// The entry boundary only hands us the raw `source` (string or pre-parsed AST)
// and `operationName`; the parsed document — and therefore the precise
// operation signature — is only known once mercurius parses internally. On the
// cold path the `validate` sub-plugin refines the resource/operation tags onto
// this span via `ctx.currentStore.graphqlRequestSpan` once the document is
// available, so we never re-parse on the hot path. On the JIT warm path no
// sub-span fires, so we recover the same tags from the cache the cold path
// populated, keyed by source + operationName.
class GraphQLRequestPlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'request'
  static type = 'graphql'
  static kind = 'server'
  static prefix = 'tracing:orchestrion:mercurius:apm:graphql:request'

  bindStart (ctx) {
    // fastifyGraphQl(source, context, variables, operationName)
    const source = ctx.arguments?.[0]
    const operationName = ctx.arguments?.[3]

    // `source` is the request text on the common path, but mercurius also
    // accepts a pre-parsed document AST; only a string is the query text, and
    // `graphql.source` carries only the text form.
    const docSource = typeof source === 'string' ? source : undefined

    // Warm (JIT-compiled) path: execute never fires, so recover the operation
    // signature/type the cold path cached, keyed by source + operationName —
    // by query text for a string, by document identity for a pre-parsed AST.
    // Empty on the cold path — validate hasn't refined yet — where the request
    // span is refined from the parsed document instead.
    const cached = getCachedRequestOperation(source, operationName)

    const span = this.startSpan(this.operationName({ id: 'request' }), {
      service: this.config.service || this.serviceName(),
      // The cached signature is the precise resource; otherwise provisional and
      // refined by the validate sub-plugin once the document is parsed.
      // `operationName` is the best name at the boundary; falls back to the
      // operation signature once validate sees the document.
      resource: cached?.signature || operationName || undefined,
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.type': cached?.type,
        'graphql.operation.name': cached?.name || operationName,
        'graphql.source': this.config.source ? docSource : undefined,
      },
    }, ctx)

    // Hand the span, the requested operation name, and the raw source to the
    // validate sub-plugin running inside this store so it can refine the
    // resource + operation tags from the parsed document (validate is the first
    // boundary that has it) and cache them keyed by the source the request
    // boundary saw. The raw source is the cache key — validate sees mercurius's
    // internally parsed document, not the caller's source, and for a pre-parsed
    // AST the two are different objects.
    ctx.currentStore.graphqlRequestSpan = span
    ctx.currentStore.graphqlRequestOperationName = operationName
    ctx.currentStore.graphqlRequestSource = source

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    /* istanbul ignore next: currentStore is populated for the request lifecycle; activeSpan is base-plugin fallback. */
    const span = ctx?.currentStore?.span || this.activeSpan
    /* istanbul ignore if: startSpan always populates currentStore for the request lifecycle. */
    if (!span) return ctx.parentStore

    const result = ctx.result
    if (result?.errors?.length) {
      span.setTag('error', result.errors[0])
      for (const error of result.errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, error)
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
