'use strict'

const { tracingChannel } = /** @type {import('node:diagnostics_channel')} */ (require('dc-polyfill'))
const clientCH = tracingChannel('apm:prisma')
const { storage } = require('../../datadog-core')

const allowedClientSpanOperations = new Set([
  'operation',
  'serialize',
  'transaction',
])

class DatadogTracingHelper {
  #prismaClient
  #dbConfig

  /**
   * @param {import('../../datadog-instrumentations/src/prisma').DbConfig|undefined} dbConfig
   * @param {import('./index')} prismaClient
   */
  constructor (dbConfig, prismaClient) {
    this.#dbConfig = dbConfig
    this.#prismaClient = prismaClient
  }

  isEnabled () {
    return true
  }

  /**
   * Needs a sampled tracecontext to generate engine spans
   *
   * @param {object} [context]
   * @returns {string}
   */
  getTraceParent (context) {
    const store = storage('legacy').getStore()
    const span = store?.span
    if (span?._spanContext) {
      const context = span._spanContext

      const traceId = context.toTraceId(true)
      const spanId = context.toSpanId(true)
      const version = (context._traceparent && context._traceparent.version) || '00'

      // always sampled a sampled traceparent due to the following reasons:
      // 1. Datadog spans are sampled on span.finish
      // 2. Prisma engine spans only generate spans when the trace is sampled
      return `${version}-${traceId}-${spanId}-01`
    }

    // No active span - return sampled
    return '00-00000000000000000000000000000000-0000000000000000-01'
  }

  /**
   * @param {object[]} spans
   */
  dispatchEngineSpans (spans) {
    if (!spans?.length) {
      return
    }
    const childrenByParent = new Map()
    for (const span of spans) {
      const parentId = span.parentId
      const children = childrenByParent.get(parentId)
      if (children) {
        children.push(span)
      } else {
        childrenByParent.set(parentId, [span])
      }
    }

    const roots = childrenByParent.get(null)
    if (!roots) {
      return
    }
    for (const span of roots) {
      this.#prismaClient.startEngineSpan({ engineSpan: span, childrenByParent, dbConfig: this.#dbConfig })
    }
  }

  getActiveContext () {
    const store = storage('legacy').getStore()
    return store?.span?._spanContext
  }

  /**
   * @param {object} options
   * @param {Function} callback
   * @returns {unknown}
   */
  runInChildSpan (options, callback) {
    if (!clientCH.start?.hasSubscribers) {
      return callback.apply(this, arguments)
    }
    if (typeof options === 'string') {
      options = {
        name: options,
      }
    }
    if (allowedClientSpanOperations.has(options.name)) {
      const ctx = {
        resourceName: options.name,
        attributes: options.attributes || {},
      }

      if (options.name !== 'serialize') {
        return clientCH.tracePromise(callback, ctx, this, ...arguments)
      }

      return clientCH.traceSync(callback, ctx, this, ...arguments)
    }
    return callback()
  }
}

module.exports = DatadogTracingHelper
