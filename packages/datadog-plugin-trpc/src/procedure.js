'use strict'

const { storage } = require('../../datadog-core')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const legacyStorage = storage('legacy')

/**
 * @typedef {{
 *   arguments: [{ path?: string, type?: string }],
 *   currentStore?: { span: import('../../dd-trace/src/opentracing/span') },
 *   error?: unknown
 * }} ProcedureContext
 * @typedef {{ currentStore?: { span: import('../../../').Span }, error?: unknown }}
 *   ProcedureCompletionContext
 */

class TrpcProcedurePlugin extends TracingPlugin {
  static id = 'trpc'
  static prefix = 'tracing:orchestrion:@trpc/server:procedure'

  /** @param {ProcedureContext} ctx */
  bindStart (ctx) {
    const { path, type } = ctx.arguments[0]
    if (typeof path !== 'string' || (type !== 'query' && type !== 'mutation')) {
      return legacyStorage.getStore()
    }

    this.startSpan('trpc.procedure', {
      resource: `${type} ${path}`,
      kind: 'internal',
    }, ctx)
    return ctx.currentStore
  }

  /** @param {ProcedureCompletionContext} ctx */
  error (ctx) {
    ctx.currentStore?.span.setTag('error', ctx.error)
  }

  /** @param {ProcedureCompletionContext} ctx */
  asyncEnd (ctx) {
    ctx.currentStore?.span.finish()
  }
}

module.exports = TrpcProcedurePlugin
