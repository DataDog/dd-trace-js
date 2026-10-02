'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const {
  INSTRUMENTATION_HTTP_RESOURCE,
  otelHttpResourceName,
} = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')
const getHostname = require('./url')

/**
 * @typedef {{
 *   self: { url: string },
 *   currentStore?: { span: import('../../..').Span },
 *   result?: { error?: (Error & { status?: number }) | null },
 *   error?: Error & { status?: number }
 * }} AuthContext
 */

class SupabaseGoTrueClientGetUserPlugin extends ClientPlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/auth-js:GoTrueClient_getUser'

  /** @param {AuthContext} ctx */
  bindStart (ctx) {
    const method = 'GET'
    const url = stripQueryAndFragment(`${ctx.self?.url}/user`)
    let resource = `${method} ${extractPathFromUrl(url)}`
    const meta = {
      component: 'supabase',
      'span.kind': 'client',
      'http.method': method,
      'http.url': url,
      'out.host': getHostname(url),
    }
    if (this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
      resource = otelHttpResourceName(method)
      meta[INSTRUMENTATION_HTTP_RESOURCE] = resource
    }

    this.startSpan('supabase.http.getuser', {
      service: { name: this.tracer._service },
      type: 'http',
      resource,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /** @param {AuthContext} ctx */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  /** @param {AuthContext} ctx */
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const error = normalizeError(ctx.result?.error, 'AuthError')
    if (error) {
      ctx.error = error
      super.error(ctx)
    }

    const status = ctx.result?.error?.status ??
      ctx.error?.status ??
      (ctx.result && !ctx.result.error ? 200 : undefined)
    if (status) ctx.currentStore?.span.setTag('http.status_code', status)

    super.finish(ctx)
  }
}

module.exports = SupabaseGoTrueClientGetUserPlugin
