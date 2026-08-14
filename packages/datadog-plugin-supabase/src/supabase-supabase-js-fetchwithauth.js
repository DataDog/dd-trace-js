'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const getService = require('./service')

class SupabaseFetchWithAuthPlugin extends StoragePlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/supabase-js:fetchWithAuth'

  bindStart (ctx) {
    const input = ctx.arguments?.[0]
    const requestUrl = input?.url || input?.href || input
    const url = stripQueryAndFragment(String(requestUrl))
    const method = String(ctx.arguments?.[1]?.method || input?.method || 'GET').toUpperCase()

    this.startSpan('supabase.storage.select', {
      service: getService(this.config.service, this.tracer._service),
      type: 'storage',
      resource: `${method} ${extractPathFromUrl(url)}`,
      meta: {
        component: 'supabase',
        'span.kind': 'client',
        'http.method': method,
        'http.url': url,
      },
    }, ctx)

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const status = ctx.result?.status
    if (status) ctx.currentStore?.span.setTag('http.status_code', status)

    super.finish(ctx)
  }
}

module.exports = SupabaseFetchWithAuthPlugin
