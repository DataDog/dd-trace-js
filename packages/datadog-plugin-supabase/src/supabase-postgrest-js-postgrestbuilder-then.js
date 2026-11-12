'use strict'

const { storage } = require('../../datadog-core')
const log = require('../../dd-trace/src/log')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')

const spanFinished = Symbol('spanFinished')

const operationByMethod = {
  DELETE: 'DELETE',
  GET: 'SELECT',
  HEAD: 'SELECT',
  PATCH: 'UPDATE',
  POST: 'INSERT',
}

/**
 * @typedef {{
 *   arguments: { [index: number]: unknown, length: number, 0?: Function, 1?: Function },
 *   self: { method: string, url: URL, schema?: string },
 *   currentStore?: { span: import('../../..').Span },
 *   parentStore: import('../../datadog-core/src/storage').Store<unknown>,
 *   result?: { error?: Error | { message?: string } | null },
 *   error?: unknown
 * } & Record<symbol, boolean | undefined>} PostgrestContext
 */

function finishSafely (plugin, ctx, hasError = false) {
  try {
    if (hasError) plugin.error(ctx)
    plugin.finish(ctx)
  } catch (error) {
    log.error('Error in plugin handler:', error)
    log.info('Disabling plugin: %s', plugin.constructor.name)
    plugin.configure(false)
  }
}

class SupabasePostgrestBuilderThenPlugin extends DatabasePlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/postgrest-js:PostgrestBuilder_then'

  /** @param {PostgrestContext} ctx */
  bindStart (ctx) {
    const method = ctx.self?.method
    const requestUrl = ctx.self?.url
    const url = stripQueryAndFragment(String(requestUrl))
    const path = extractPathFromUrl(url)
    const operation = path.includes('/rpc/') ? 'CALL' : operationByMethod[method] || method
    const resource = `${operation} ${path.slice(path.lastIndexOf('/') + 1)}`

    this.startSpan('supabase.database.query', {
      service: { name: this.tracer._service },
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
        finishSafely(plugin, ctx)
        return storage('legacy').run(ctx.parentStore, () => onFulfilled.apply(this, arguments))
      }
    }

    const onRejected = ctx.arguments?.[1]
    if (typeof onRejected === 'function') {
      const plugin = this
      ctx.arguments[1] = function (error) {
        ctx.error = error
        finishSafely(plugin, ctx, true)
        return storage('legacy').run(ctx.parentStore, () => onRejected.apply(this, arguments))
      }
    }

    return ctx.currentStore
  }

  /** @param {PostgrestContext} ctx */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  /** @param {PostgrestContext} ctx */
  error (ctx) {
    if (ctx[spanFinished]) return
    super.error(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  /** @param {PostgrestContext} ctx */
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (ctx[spanFinished] || !ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

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
