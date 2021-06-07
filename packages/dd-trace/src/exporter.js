'use strict'

const AgentExporter = require('./exporters/agent')
const LogExporter = require('./exporters/log')
const JaegerExporter = require('./exporters/jaeger')
const exporters = require('../../../ext/exporters')
const fs = require('fs')
const constants = require('./constants')

module.exports = (name) => {
  const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
  const usingLambdaExtension = inAWSLambda && fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH)
  switch (name) {
    case exporters.JAEGER:
      return JaegerExporter
    case exporters.LOG:
      return LogExporter
    case exporters.AGENT:
      return AgentExporter
    default:
      if (inAWSLambda) {
        return !usingLambdaExtension ? LogExporter : AgentExporter
      }
      return JaegerExporter
  }
}
