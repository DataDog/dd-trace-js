'use strict'

const log = require('../../dd-trace/src/log')
const eventType = require('./event-type-guards')
const httpExtractor = require('./extractors/http')
const sqsExtractor = require('./extractors/sqs')
const snsExtractor = require('./extractors/sns')
const kinesisExtractor = require('./extractors/kinesis')
const eventBridgeExtractor = require('./extractors/event-bridge')
const stepFunctionExtractor = require('./extractors/step-function')
const lambdaContextExtractor = require('./extractors/lambda-context')
const xrayService = require('./xray-service')

function getEventExtractor (event) {
  if (!event || typeof event !== 'object') return undefined

  const headers = event.headers ?? event.multiValueHeaders
  if (headers !== null && headers !== undefined && typeof headers === 'object') {
    return httpExtractor
  }

  if (eventType.isSNSEvent(event)) return snsExtractor
  if (eventType.isSNSSQSEvent(event)) return sqsExtractor
  if (eventType.isEBSQSEvent(event)) return eventBridgeExtractor
  if (eventType.isSQSEvent(event)) return sqsExtractor
  if (eventType.isKinesisStreamEvent(event)) return kinesisExtractor
  if (eventType.isEventBridgeEvent(event)) return eventBridgeExtractor

  return undefined
}

function extractTraceContext (event, context, tracer, config) {
  let spanContext = null

  if (config && config.traceExtractor) {
    try {
      const customContext = config.traceExtractor(event, context)
      if (customContext) {
        spanContext = tracer.extract('text_map', customContext)
      }
    } catch (error) {
      log.debug('Custom trace extractor failed: %s', error.message)
    }
  }

  if (spanContext === null) {
    const extractor = getEventExtractor(event)
    if (extractor !== undefined) {
      spanContext = extractor.extract(event, tracer, config)
    }
  }

  if (spanContext === null && eventType.isStepFunctionsEvent(event)) {
    spanContext = stepFunctionExtractor.extract(event)
  }

  if (spanContext === null) {
    spanContext = lambdaContextExtractor.extract(event, tracer, config, context)
  }

  if (spanContext !== null) {
    addTraceContextToXray(spanContext)
    return spanContext
  }

  const xrayContext = xrayService.extractXrayContext()
  if (xrayContext !== null) {
    log.debug('Extracted trace context from X-Ray')
    const carrier = {
      'x-datadog-trace-id': xrayContext.traceId,
      'x-datadog-parent-id': xrayContext.parentId,
    }
    // Only propagate X-Ray sampling when mergeXrayTraces is enabled.
    // Otherwise, X-Ray's Sampled=0 would cause dd-trace to drop the trace.
    // Let dd-trace's own sampler decide when not merging.
    if (config?.mergeXrayTraces) {
      carrier['x-datadog-sampling-priority'] = String(xrayContext.sampleMode)
    }
    const xraySpanContext = tracer.extract('text_map', carrier)
    return xraySpanContext
  }

  return null
}

function addTraceContextToXray (spanContext) {
  try {
    const traceId = spanContext.toTraceId ? spanContext.toTraceId() : undefined
    const parentId = spanContext.toSpanId ? spanContext.toSpanId() : undefined
    const samplingPriority = spanContext._sampling ? spanContext._sampling.priority : undefined

    if (traceId && parentId) {
      xrayService.addMetadata({
        'trace-id': traceId,
        'parent-id': parentId,
        'sampling-priority': samplingPriority
      })
      log.debug('Added trace context to X-Ray metadata')
    }
  } catch (error) {
    log.debug('Could not add trace context to X-Ray metadata: %s', error.message)
  }
}

module.exports = {
  extractTraceContext,
  getEventExtractor
}
