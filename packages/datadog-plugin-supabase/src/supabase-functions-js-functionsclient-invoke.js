'use strict'

const { URL } = require('node:url')

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const {
  INSTRUMENTATION_HTTP_RESOURCE,
  otelHttpResourceName,
} = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const { buildClientHttpUrl, extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const log = require('../../dd-trace/src/log')
const normalizeError = require('./error')
const getHostname = require('./url')

/**
 * @typedef {{
 *   arguments: { [index: number]: unknown, length: number, 0?: string, 1?: { method?: string, region?: string } },
 *   self: { url: string, region?: string },
 *   currentStore?: { span: import('../../..').Span },
 *   result?: { error?: Error | { message?: string } | null, response?: { status?: number } },
 *   error?: unknown
 * }} FunctionsContext
 */

class SupabaseFunctionsClientInvokePlugin extends ClientPlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/functions-js:FunctionsClient_invoke'

  /** @param {FunctionsContext} ctx */
  bindStart (ctx) {
    const functionName = ctx.arguments?.[0]
    const method = String(ctx.arguments?.[1]?.method || 'POST').toUpperCase()
    const rawUrl = `${ctx.self?.url}/${functionName}`
    const url = stripQueryAndFragment(rawUrl)
    const otelSemantics = this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED
    const resource = otelSemantics ? otelHttpResourceName(method) : `${method} ${extractPathFromUrl(url)}`
    let httpUrl = url
    if (otelSemantics) {
      try {
        const requestUrl = new URL(rawUrl)
        const region = ctx.arguments?.[1]?.region || ctx.self?.region
        if (region && region !== 'any') {
          requestUrl.searchParams.set('forceFunctionRegion', region)
        }
        requestUrl.hash = ''
        httpUrl = buildClientHttpUrl(this.config, '', requestUrl.href, url)
      } catch (error) {
        log.debug('Could not build Supabase function request URL: %s', error.message)
      }
    }
    const meta = {
      component: 'supabase',
      'span.kind': 'client',
      'http.method': method,
      'http.url': httpUrl,
      'out.host': getHostname(url),
      'faas.invoked_name': functionName,
    }
    if (otelSemantics) {
      meta[INSTRUMENTATION_HTTP_RESOURCE] = resource
    }

    this.startSpan('supabase.http.invoke', {
      service: { name: this.tracer._service },
      type: 'http',
      resource,
      meta,
    }, ctx)

    return ctx.currentStore
  }

  /** @param {FunctionsContext} ctx */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  /** @param {FunctionsContext} ctx */
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
