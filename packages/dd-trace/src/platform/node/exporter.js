'use strict'
const AgentExporter = require('../../exporters/agent')
const LogExporter = require('../../exporters/log')
const env = require('./env')

module.exports = () => {
  const inAWSLambda = env('AWS_LAMBDA_FUNCTION_NAME') !== undefined
  return inAWSLambda ? LogExporter : AgentExporter
}
