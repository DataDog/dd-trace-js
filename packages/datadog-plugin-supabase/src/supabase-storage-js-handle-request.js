'use strict'

const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const { extractPathFromUrl } = require('../../dd-trace/src/plugins/util/url')
const { stripQueryAndFragment } = require('../../dd-trace/src/util')
const getService = require('./service')

const storageRoutes = [
  'object/upload/sign',
  'object/list-v2',
  'object/list',
  'object/sign',
  'object/info',
  'object/copy',
  'object/move',
  'render/image',
  'bucket',
  'object',
  'cdn',
]

/**
 * Returns a low-cardinality storage route for a request URL.
 *
 * @param {string|URL} url Request URL.
 * @returns {string} Normalized storage route.
 */
function getStorageRoute (url) {
  const path = extractPathFromUrl(stripQueryAndFragment(String(url)))
  const marker = '/storage/v1/'
  const markerIndex = path.indexOf(marker)
  const storagePath = markerIndex === -1 ? path.replace(/^\/+/, '') : path.slice(markerIndex + marker.length)

  for (const route of storageRoutes) {
    if (storagePath === route || storagePath.startsWith(`${route}/`)) return route
  }

  return 'storage'
}

class SupabaseStorageHandleRequestPlugin extends StoragePlugin {
  static id = 'supabase'
  static prefix = 'tracing:orchestrion:@supabase/storage-js:handleRequest'

  /**
   * Starts a storage request span.
   *
   * @param {object} ctx Orchestrion context.
   * @returns {object} Span store.
   */
  bindStart (ctx) {
    const method = String(ctx.arguments?.[1] || 'GET').toUpperCase()
    const url = ctx.arguments?.[2]

    this.startSpan('supabase.storage.request', {
      service: getService(this.config.service, this.tracer._service),
      type: 'storage',
      resource: `${method} ${getStorageRoute(url)}`,
      meta: {
        component: 'supabase',
        'span.kind': 'client',
        'http.method': method,
        'http.url': stripQueryAndFragment(String(url)),
      },
    }, ctx)

    return ctx.currentStore
  }

  /**
   * Records a normalized storage request error.
   *
   * @param {object} ctx Orchestrion context.
   * @returns {void}
   */
  error (ctx) {
    const status = ctx.error?.status
    if (status) ctx.currentStore?.span.setTag('http.status_code', status)
    super.error(ctx)
  }

  /**
   * Finishes an asynchronous storage request.
   *
   * @param {object} ctx Orchestrion context.
   * @returns {void}
   */
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  /**
   * Finishes the span after the request has completed.
   *
   * @param {object} ctx Orchestrion context.
   * @returns {void}
   */
  finish (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return
    super.finish(ctx)
  }
}

module.exports = SupabaseStorageHandleRequestPlugin
