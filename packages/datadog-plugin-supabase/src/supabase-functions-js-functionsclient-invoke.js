'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')

class SupabaseFunctionsClientInvokePlugin extends ClientPlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/functions-js:FunctionsClient_invoke'

  /**
   * Starts an HTTP client span for an Edge Function invocation.
   *
   * @param {object} ctx Orchestrion context for FunctionsClient.invoke().
   * @returns {object|undefined} Span store.
   */
  bindStart (ctx) {
    const functionName = ctx.arguments?.[0]
    const method = String(ctx.arguments?.[1]?.method || 'POST').toUpperCase()
    const url = stripQueryAndFragment(`${ctx.self?.url}/${functionName}`)

    this.startSpan('supabase.http.invoke', {
      service: { name: this.tracer._service },
      type: 'http',
      resource: `${method} ${extractPathFromUrl(url)}`,
      meta: {
        component: 'supabase',
        'span.kind': 'client',
        'http.method': method,
        'http.url': url,
        'faas.invoked_name': functionName,
      },
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Finishes an asynchronous Edge Function invocation.
   *
   * @param {object} ctx Completed Orchestrion context.
   * @returns {void}
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  /**
   * Records the Functions result and finishes its HTTP client span.
   *
   * @param {object} ctx Completed Orchestrion context.
   * @returns {void}
   */
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const error = normalizeError(ctx.result?.error, 'FunctionsError')
    if (error) {
      ctx.error = error
      super.error(ctx)
    }

    const status = ctx.result?.response?.status
    if (status) ctx.currentStore?.span.setTag('http.status_code', status)

    super.finish(ctx)
  }
}

module.exports = SupabaseFunctionsClientInvokePlugin
