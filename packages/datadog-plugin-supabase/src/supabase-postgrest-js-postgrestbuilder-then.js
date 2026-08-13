'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')
const getService = require('./service')

const operationByMethod = {
  DELETE: 'DELETE',
  GET: 'SELECT',
  HEAD: 'SELECT',
  PATCH: 'UPDATE',
  POST: 'INSERT'
}

class SupabasePostgrestBuilderThenPlugin extends DatabasePlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/postgrest-js:PostgrestBuilder_then'

  bindStart (ctx) {
    const method = ctx.self?.method
    const requestUrl = ctx.self?.url
    const url = stripQueryAndFragment(String(requestUrl))
    const path = extractPathFromUrl(url)
    const operation = path.includes('/rpc/') ? 'CALL' : operationByMethod[method] || method
    const resource = `${operation} ${path.slice(path.lastIndexOf('/') + 1)}`

    const span = this.startSpan('supabase.database.select', {
      service: getService(this.config.service, this.tracer._service),
      type: 'sql',
      resource,
      meta: {
        component: 'supabase',
        'span.kind': 'client',
        'db.type': 'postgres',
        'db.name': ctx.self?.schema || 'public',
        'db.operation': operation,
        'out.host': requestUrl?.hostname
      }
    }, ctx)

    const onFulfilled = ctx.arguments?.[0]
    if (typeof onFulfilled === 'function') {
      ctx.arguments[0] = function (result) {
        const error = normalizeError(result?.error, 'PostgrestError')
        if (error) span.setTag('error', error)
        return onFulfilled.apply(this, arguments)
      }
    }

    const onRejected = ctx.arguments?.[1]
    if (typeof onRejected === 'function') {
      ctx.arguments[1] = function (error) {
        span.setTag('error', error)
        return onRejected.apply(this, arguments)
      }
    }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const error = normalizeError(ctx.result?.error, 'PostgrestError')
    if (error) {
      ctx.error = error
      super.error(ctx)
    }

    super.finish(ctx)
  }
}

module.exports = SupabasePostgrestBuilderThenPlugin
