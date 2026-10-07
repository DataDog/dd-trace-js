'use strict'

const _tracer = require('../../../../dd-trace')

const datadog = (handler) => async (...args) => {
  const wrappedHandler = _tracer.wrap('aws.lambda', {}, handler)
  return wrappedHandler(...args)
}

module.exports = datadog
