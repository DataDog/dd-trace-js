'use strict'

const _tracer = require('../../../../dd-trace')

const datadog = (handler) => async (...args) => {
  return _tracer.wrap('aws.lambda', {}, handler)(...args)
}

module.exports = datadog
