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
// cold path the `execute` sub-plugin backfills the resource/operation tags onto
// this span via `ctx.currentStore.graphqlRequestSpan` once the document is
// available, so we never re-parse on the hot path. On the JIT warm path execute
// never fires, so we recover the same tags from the source-keyed cache the cold
// path populated.
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
    // accepts a pre-parsed document AST; only a string is the query text.
    const docSource = typeof source === 'string' ? source : undefined

    // Warm (JIT-compiled) path: execute never fires, so recover the operation
    // signature/type the cold path cached by source. Empty on the cold path —
    // execute hasn't run yet — where the execute sub-plugin backfills instead.
    const cached = getCachedRequestOperation(docSource)

    const span = this.startSpan(this.operationName({ id: 'request' }), {
      service: this.config.service || this.serviceName(),
      // The cached signature is the precise resource; otherwise provisional and
      // refined by the execute sub-plugin once the document is parsed.
      // `operationName` is the best name at the boundary; falls back to the
      // operation kind in execute.
      resource: cached?.signature || operationName || undefined,
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.type': cached?.type,
        'graphql.operation.name': cached?.name || operationName,
        'graphql.source': this.config.source ? docSource : undefined,
      },
    }, ctx)

    // Hand the span to the execute sub-plugin running inside this store so it
    // can backfill the resource + operation tags from the parsed document.
    ctx.currentStore.graphqlRequestSpan = span

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
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
    const span = ctx?.currentStore?.span || this.activeSpan
    if (span && ctx?.error) {
      span.setTag('error', ctx.error)
    }
  }
}

module.exports = GraphQLRequestPlugin
