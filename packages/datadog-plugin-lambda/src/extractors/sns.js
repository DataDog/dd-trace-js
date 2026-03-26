'use strict'

const log = require('../../../dd-trace/src/log')

const AMZN_TRACE_ID_ENV_VAR = '_X_AMZN_TRACE_ID'

function getParsedRecordHeaders (record) {
  if (!record) return null
  try {
    const messageAttribute = record.Sns?.MessageAttributes?._datadog
    if (messageAttribute?.Value) {
      if (messageAttribute.Type === 'String') {
        return JSON.parse(messageAttribute.Value)
      }
      const decodedValue = Buffer.from(messageAttribute.Value, 'base64').toString('ascii')
      return JSON.parse(decodedValue)
    }
    return null
  } catch (error) {
    return null
  }
}

function extract (event, tracer) {
  try {
    const firstRecordHeaders = getParsedRecordHeaders(event?.Records?.[0])

    if (firstRecordHeaders) {
      const spanContext = tracer.extract('text_map', firstRecordHeaders)
      if (spanContext) {
        log.debug('Extracted trace context from SNS event')
        return spanContext
      }
      log.debug('Failed to extract trace context from SNS event')
    }

    if (process.env[AMZN_TRACE_ID_ENV_VAR]) {
      const { extractDDContextFromAWSTraceHeader } = require('../xray-service')
      const spanContext = extractDDContextFromAWSTraceHeader(process.env[AMZN_TRACE_ID_ENV_VAR])
      if (spanContext) {
        log.debug('Extracted trace context from SNS event via _X_AMZN_TRACE_ID')
        return spanContext
      }
      log.debug('No Datadog trace context found from SNS event via _X_AMZN_TRACE_ID')
    }
  } catch (error) {
    log.debug('Unable to extract trace context from SNS event: %s', error.message)
  }

  return null
}

module.exports = {
  extract,
  getParsedRecordHeaders,
  AMZN_TRACE_ID_ENV_VAR
}
