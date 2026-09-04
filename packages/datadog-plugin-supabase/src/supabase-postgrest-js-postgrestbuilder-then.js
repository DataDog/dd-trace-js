'use strict'

const { storage } = require('../../datadog-core')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')
const getService = require('./service')

const spanFinished = Symbol('spanFinished')

const operationByMethod = {
  DELETE: 'DELETE',
  GET: 'SELECT',
  HEAD: 'SELECT',
  PATCH: 'UPDATE',
  POST: 'INSERT',
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

    this.startSpan('supabase.database.query', {
      service: getService(this.config.service, this.tracer._service),
      type: 'sql',
      resource,
      meta: {
        component: 'supabase',
        'span.kind': 'client',
        'db.type': 'postgres',
        'db.name': ctx.self?.schema || 'public',
        'db.operation': operation,
        'out.host': requestUrl?.hostname,
      },
    }, ctx)

    // PostgrestBuilder.then owns both the request and consumer callbacks. Finish the request span and
    // restore its parent before invoking a callback so application failures and latency stay outside it.
    const onFulfilled = ctx.arguments?.[0]
    if (typeof onFulfilled === 'function') {
      const plugin = this
      ctx.arguments[0] = function (result) {
        ctx.result = result
        plugin.finish(ctx)
        return storage('legacy').run(ctx.parentStore, () => onFulfilled.apply(this, arguments))
      }
    }

    const onRejected = ctx.arguments?.[1]
    if (typeof onRejected === 'function') {
      const plugin = this
      ctx.arguments[1] = function (error) {
        ctx.error = error
        plugin.error(ctx)
        plugin.finish(ctx)
        return storage('legacy').run(ctx.parentStore, () => onRejected.apply(this, arguments))
      }
    }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  error (ctx) {
    if (ctx[spanFinished]) return
    super.error(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (ctx[spanFinished]) return
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const error = normalizeError(ctx.result?.error, 'PostgrestError')
    if (error) {
      ctx.error = error
      super.error(ctx)
    }

    ctx[spanFinished] = true
    super.finish(ctx)
  }
}

module.exports = SupabasePostgrestBuilderThenPlugin
