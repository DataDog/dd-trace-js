'use strict'

// Ported from datadog-lambda-js at da9fc3c0; propagation itself stays core-owned.
const { getEnvironmentVariable } = require('../../../dd-trace/src/config/helper')
const log = require('../../../dd-trace/src/log')
const guards = require('../event-type-guards')
const {
  getSNSHeaders,
  getSNSSQSHeaders,
  getSQSHeaders,
  getEventBridgeSQSHeaders,
  extractKinesis,
  extractMSK,
  extractDurableExecution,
} = require('./events')
const { extractHTTP } = require('./http')
const { fromTraceContext } = require('./span-context')
const { getStepFunctionContext, extractStepFunctionContext } = require('./step-functions')
const { extractDatadogContext, extractXrayContext } = require('./xray')

/**
 * @typedef {object} ExtractedContext
 * @property {import('../../../dd-trace/src/opentracing/span_context')|null} spanContext
 * @property {'event'|'xray'|'ddtrace'|undefined} source
 */

class TraceContextExtractor {
  #tracer
  #config
  #stepFunction

  /**
   * One extractor per invocation keeps source first-use Step Functions caching invocation-local.
   * @param {import('../../../dd-trace/src/opentracing/tracer')} tracer Core tracer.
   * @param {import('../../../../index').plugins.aws_lambda} config Lambda configuration.
   */
  constructor (tracer, config) {
    this.#tracer = tracer
    this.#config = config
  }

  /**
   * @param {Record<string, unknown>} event Lambda event.
   * @param {Record<string, unknown>} context Lambda context.
   * @returns {ExtractedContext|Promise<ExtractedContext>}
   */
  extract (event, context) {
    if (this.#config.traceExtractor) return this.#extractCustom(event, context)
    return this.#extractFallback(event, context)
  }

  /**
   * @param {Record<string, unknown>} event Lambda event.
   * @param {Record<string, unknown>} context Lambda context.
   * @returns {Promise<ExtractedContext>}
   */
  async #extractCustom (event, context) {
    try {
      const custom = await this.#config.traceExtractor(event, context)
      const spanContext = fromTraceContext(custom)
      if (spanContext !== null) return { spanContext, source: custom.source }
    } catch (error) {
      log.error('Unable to extract trace context. Custom extractor function failed: %s', error)
    }
    return this.#extractFallback(event, context)
  }

  /**
   * @param {Record<string, unknown>} event Lambda event.
   * @param {Record<string, unknown>} context Lambda context.
   * @returns {ExtractedContext}
   */
  #extractFallback (event, context) {
    let spanContext = this.#extractEvent(event)
    if (spanContext === null) spanContext = this.#extractStepFunction(event)
    if (spanContext === null && context && typeof context === 'object') {
      const custom = context.clientContext?.custom
      if (custom && typeof custom === 'object') {
        spanContext = this.#tracer.extract('text_map', custom._datadog === undefined ? custom : custom._datadog)
      }
    }
    if (spanContext !== null) return { spanContext, source: 'event' }
    return { spanContext: extractXrayContext(), source: 'xray' }
  }

  /**
   * @param {Record<string, unknown>} event Lambda event.
   * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
   */
  #extractEvent (event) {
    if (!event || typeof event !== 'object') return null
    if (guards.isDurableExecutionEvent(event)) return extractDurableExecution(event, this.#tracer)
    const headers = event.headers ?? event.multiValueHeaders
    if (headers !== null && typeof headers === 'object') {
      return extractHTTP(event, this.#tracer, this.#config.decodeAuthorizerContext)
    }
    if (guards.isSNSEvent(event)) {
      return this.#extractMessage(getSNSHeaders(event.Records[0]), getEnvironmentVariable('_X_AMZN_TRACE_ID'))
    }
    if (guards.isSNSSQSEvent(event)) {
      return this.#extractMessage(getSNSSQSHeaders(event.Records[0]), event.Records[0]?.attributes?.AWSTraceHeader)
    }
    if (guards.isEventBridgeSQSEvent(event)) {
      return this.#extractMessage(getEventBridgeSQSHeaders(event.Records[0]))
    }
    if (guards.isAppSyncResolverEvent(event)) {
      event.headers = event.request.headers
      return extractHTTP(event, this.#tracer, false)
    }
    if (guards.isMSKEvent(event)) return extractMSK(event, this.#tracer)
    if (guards.isSQSEvent(event)) {
      return this.#extractMessage(getSQSHeaders(event.Records[0]), event.Records[0]?.attributes?.AWSTraceHeader)
    }
    if (guards.isKinesisStreamEvent(event)) return extractKinesis(event, this.#tracer)
    if (guards.isEventBridgeEvent(event)) return this.#extractMessage(event?.detail?._datadog)
    return null
  }

  /**
   * Message carriers may contain Step Functions context instead of propagation headers.
   * @param {Record<string, string>|null|undefined} headers Message carrier.
   * @param {string} [awsTraceHeader] Optional Java-injected Datadog context.
   * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
   */
  #extractMessage (headers, awsTraceHeader) {
    try {
      if (headers) {
        const spanContext = this.#tracer.extract('text_map', headers) || this.#extractStepFunction(headers)
        if (spanContext) return spanContext
      }
      if (awsTraceHeader !== undefined) return extractDatadogContext(awsTraceHeader)
    } catch (error) {
      log.debug('Unable to extract trace context from message: %s', error)
    }
    return null
  }

  /**
   * @param {Record<string, unknown>} event Event or message carrier.
   * @returns {import('../../../dd-trace/src/opentracing/span_context')|null}
   */
  #extractStepFunction (event) {
    this.#stepFunction ??= { context: getStepFunctionContext(event) }
    return extractStepFunctionContext(this.#stepFunction.context)
  }
}

module.exports = TraceContextExtractor
