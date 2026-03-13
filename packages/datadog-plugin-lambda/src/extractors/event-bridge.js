'use strict'

const log = require('../../../dd-trace/src/log')

function extract (event, tracer) {
  try {
    const headers = event?.detail?._datadog
    if (headers) {
      const spanContext = tracer.extract('text_map', headers)
      if (spanContext) {
        log.debug('Extracted trace context from EventBridge event')
        return spanContext
      }
    }
  } catch (error) {
    log.debug('Unable to extract trace context from EventBridge event: %s', error.message)
  }

  return null
}

module.exports = {
  extract
}
