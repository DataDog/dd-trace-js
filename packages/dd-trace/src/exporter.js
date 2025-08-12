'use strict'

const exporters = require('../../../ext/exporters')
const fs = require('fs')
const constants = require('./constants')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

module.exports = function getExporter (name) {
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
    case exporters.CUCUMBER_WORKER:
    case exporters.MOCHA_WORKER:
    case exporters.PLAYWRIGHT_WORKER:
      return require('./ci-visibility/exporters/test-worker')
    default: {
      const inAWSLambda = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
      const usingLambdaExtension = inAWSLambda && fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH)
      return require(inAWSLambda && !usingLambdaExtension ? './exporters/log' : './exporters/agent')
    }
  }
}
