'use strict'

const exporters = require('../../../ext/exporters')
const fs = require('fs')
const constants = require('./constants')

module.exports = name => {
  const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
  const usingLambdaExtension = inAWSLambda && fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH)

  switch (name) {
    case exporters.LOG:
      return require('./exporters/log')
    case exporters.AGENT:
      return require('./exporters/agent')
    case exporters.DATADOG:
      return require('./ci-visibility/exporters/agentless')
    case exporters.AGENT_PROXY:
      return require('./ci-visibility/exporters/agent-proxy')
    case exporters.JEST_WORKER:
      return require('./ci-visibility/exporters/jest-worker')
    default:
      return inAWSLambda && !usingLambdaExtension ? require('./exporters/log') : require('./exporters/agent')
  }
}
