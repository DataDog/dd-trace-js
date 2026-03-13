'use strict'

const log = require('../../../dd-trace/src/log')

function getParsedRecordHeaders (record) {
  if (!record) return null
  try {
    let headers = record.messageAttributes?._datadog?.stringValue
    if (!headers) {
      const encodedTraceContext = record.messageAttributes?._datadog?.binaryValue
      if (encodedTraceContext) {
        headers = Buffer.from(encodedTraceContext, 'base64').toString('ascii')
      }
    }
    return headers ? JSON.parse(headers) : null
  } catch (error) {
    return null
  }
}

function extract (event, tracer) {
  log.debug('SQS extractor being used')
  try {
    const firstRecordHeaders = getParsedRecordHeaders(event?.Records?.[0])

    if (firstRecordHeaders) {
      const spanContext = tracer.extract('text_map', firstRecordHeaders)
      if (spanContext) {
        log.debug('Extracted trace context from SQS event')
        return spanContext
      }
      log.debug('Failed to extract trace context from SQS event')
    }

    const awsTraceHeader = event?.Records?.[0]?.attributes?.AWSTraceHeader
    if (awsTraceHeader !== undefined) {
      const { extractDDContextFromAWSTraceHeader } = require('../xray-service')
      const spanContext = extractDDContextFromAWSTraceHeader(awsTraceHeader)
      if (spanContext) {
        log.debug('Extracted trace context from SQS event attributes AWSTraceHeader')
        return spanContext
      }
      log.debug('No Datadog trace context found from SQS event attributes AWSTraceHeader')
    }
  } catch (error) {
    log.debug('Unable to extract trace context from SQS event: %s', error.message)
  }

  return null
}

module.exports = {
  extract,
  getParsedRecordHeaders
}
