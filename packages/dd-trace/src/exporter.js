'use strict'

const AgentExporter = require('./exporters/agent')
const LogExporter = require('./exporters/log')
const exporters = require('../../../ext/exporters')

module.exports = name => {
  const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined

  switch (name) {
    case exporters.LOG:
      return LogExporter
    case exporters.AGENT:
      return AgentExporter
    default:
      return inAWSLambda ? LogExporter : AgentExporter
  }
}
