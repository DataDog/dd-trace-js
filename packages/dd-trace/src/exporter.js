'use strict'

const AgentExporter = require('./exporters/agent')
const LogExporter = require('./exporters/log')
const AgentlessCiVisibilityExporter = require('./ci-visibility/exporters/agentless')
const AgentProxyCiVisibilityExporter = require('./ci-visibility/exporters/agent-proxy')
const NAPIRSExporter = require('./exporters/napi-rs')
const exporters = require('../../../ext/exporters')
const fs = require('fs')
const constants = require('./constants')

module.exports = name => {
  const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
  const usingLambdaExtension = inAWSLambda && fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH)

  switch (name) {
    case exporters.LOG:
      return LogExporter
    case exporters.AGENT:
      return AgentExporter
    case exporters.DATADOG:
      return AgentlessCiVisibilityExporter
    case exporters.AGENT_PROXY:
      return AgentProxyCiVisibilityExporter
    case exporters.NAPI_RS:
      return NAPIRSExporter
    default:
      return inAWSLambda && !usingLambdaExtension ? LogExporter : AgentExporter
  }
}
