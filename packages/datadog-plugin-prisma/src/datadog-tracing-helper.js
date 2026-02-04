'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel
const clientCH = tracingChannel('apm:prisma')
const { storage } = require('../../datadog-core')

const allowedClientSpanOperations = new Set([
  'operation',
  'serialize',
  'transaction',
])

/**
 * @typedef {object} DbConfig
 * @property {string} [user]
 * @property {string} [password]
 * @property {string} [host]
 * @property {string} [port]
 * @property {string} [database]
 */

class DatadogTracingHelper {
  #prismaClient
  #dbConfig

  /**
   * @param {DbConfig|undefined} dbConfig
   * @param {import('./index')} prismaClient
   */
  constructor (dbConfig, prismaClient) {
    this.#dbConfig = dbConfig
    this.#prismaClient = prismaClient
    // this.#prismaEngine = new PrismaEngine()
  }

  isEnabled () {
    return true
  }

  // needs a sampled tracecontext to generate engine spans
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

    // No active span - be optimistic and return sampled
    return '00-00000000000000000000000000000000-0000000000000000-01'
  }

  dispatchEngineSpans (spans) {
    // console.log('dispatching engine spans', spans)
    for (const span of spans) {
      if (span.parentId === null) {
        this.#prismaClient.startEngineSpan({ engineSpan: span, allEngineSpans: spans, dbConfig: this.#dbConfig })
      }
    }
  }

  getActiveContext () {
    const store = storage('legacy').getStore()
    return store?.span?._spanContext
  }

  runInChildSpan (options, callback) {
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
