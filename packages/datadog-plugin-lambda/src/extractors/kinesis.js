'use strict'

const log = require('../../../dd-trace/src/log')

function getParsedRecordHeaders (record) {
  if (!record) return null
  try {
    const kinesisData = record?.kinesis?.data
    if (!kinesisData) return null

    const decodedData = Buffer.from(kinesisData, 'base64').toString('ascii')
    const parsedBody = JSON.parse(decodedData)
    return parsedBody?._datadog ?? null
  } catch (error) {
    return null
  }
}

function extract (event, tracer) {
  const kinesisData = event?.Records?.[0]?.kinesis?.data
  if (kinesisData === undefined) return null

  try {
    const headers = getParsedRecordHeaders(event?.Records?.[0])
    if (headers) {
      const spanContext = tracer.extract('text_map', headers)
      if (spanContext === null) return null

      log.debug('Extracted trace context from Kinesis event')
      return spanContext
    }
  } catch (error) {
    log.debug('Unable to extract trace context from Kinesis event: %s', error.message)
  }

  return null
}

module.exports = {
  extract,
  getParsedRecordHeaders
}
