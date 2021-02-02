'use strict'

const AgentExporter = require('./exporters/agent')
const LogExporter = require('./exporters/log')
const platform = require('./platform')
const exporters = require('../../../ext/exporters')

module.exports = name => {
  const inAWSLambda = platform.env('AWS_LAMBDA_FUNCTION_NAME') !== undefined

  switch (name) {
    case exporters.LOG:
      return LogExporter
    case exporters.AGENT:
      return AgentExporter
    default:
      return inAWSLambda ? LogExporter : AgentExporter
  }
}
