'use strict'

const log = require('../../../dd-trace/src/log')

function extract (event, tracer, config, context) {
  if (!context || typeof context !== 'object') return null

  const custom = context.clientContext?.custom
  if (!custom || typeof custom !== 'object') return null

  let headers = custom
  if (headers._datadog !== undefined) {
    headers = headers._datadog
  }

  try {
    const spanContext = tracer.extract('text_map', headers)
    if (spanContext === null) return null

    log.debug('Extracted trace context from Lambda context')
    return spanContext
  } catch (error) {
    log.debug('Unable to extract trace context from Lambda context: %s', error.message)
  }

  return null
}

module.exports = {
  extract
}
