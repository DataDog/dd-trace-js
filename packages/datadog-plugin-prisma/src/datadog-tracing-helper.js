'use strict'
require('util').inspect.defaultOptions.depth = null

const tracingChannel = require('dc-polyfill').tracingChannel
const clientCH = tracingChannel('apm:prisma')
const { storage } = require('../../datadog-core')

const allowedClientSpanOperations = new Set([
  'operation',
  'serialize',
  'transaction'
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
      const priority = context._sampling.priority

      // Option 2: Check parent sampling - if priority >= 1 (AUTO_KEEP), it's sampled
      // Option 3: Optimistic sampling - if priority is undefined/not set, assume sampled
      // Only use '00' if explicitly not sampled (priority < 1)
      const flags = (priority === undefined || priority >= 1) ? '01' : '00'

      const traceId = context.toTraceId(true)
      const spanId = context.toSpanId(true)
      const version = (context._traceparent && context._traceparent.version) || '00'

      return `${version}-${traceId}-${spanId}-${flags}`
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
        name: options
      }
    }
    if (allowedClientSpanOperations.has(options.name)) {
      const ctx = {
        resourceName: options.name,
        attributes: options.attributes || {}
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
