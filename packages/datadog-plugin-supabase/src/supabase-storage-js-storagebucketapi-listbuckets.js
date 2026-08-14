'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const normalizeError = require('./error')
const getService = require('./service')

class SupabaseStorageBucketApiListBucketsPlugin extends StoragePlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/storage-js:StorageBucketApi_listBuckets'

  bindStart (ctx) {
    const method = 'GET'
    const url = stripQueryAndFragment(`${ctx.self?.url}/bucket`)

    this.startSpan('supabase.storage.list', {
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

    const error = normalizeError(ctx.result?.error, 'StorageError')
    if (error) {
      ctx.error = error
      super.error(ctx)
    }

    const result = ctx.result
    const status = result?.error?.status || result?.error?.statusCode || (result && !result.error ? 200 : undefined)
    if (status) ctx.currentStore?.span.setTag('http.status_code', status)

    super.finish(ctx)
  }
}

module.exports = SupabaseStorageBucketApiListBucketsPlugin
