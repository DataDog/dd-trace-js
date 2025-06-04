'use strict'

const log = require('./log')
const { getEnvironmentVariable } = require('./config-helper')

function maybeStartServerlessMiniAgent (config) {
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    log.error('Serverless Mini Agent is only supported on Windows and Linux.')
    return
  }

  const rustBinaryPath = getRustBinaryPath(config)

  const fs = require('fs')

  log.debug(`Trying to spawn the Serverless Mini Agent at path: ${rustBinaryPath}`)

  // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
  // invalid paths and log our own error.
  if (!fs.existsSync(rustBinaryPath)) {
    log.error('Serverless Mini Agent did not start. Could not find mini agent binary.')
    return
  }
  try {
    require('child_process').spawn(rustBinaryPath, { stdio: 'inherit' })
  } catch (err) {
    log.error('Error spawning mini agent process: %s', err.message)
  }
}

function getRustBinaryPath (config) {
  if (getEnvironmentVariable('DD_MINI_AGENT_PATH') !== undefined) {
    return getEnvironmentVariable('DD_MINI_AGENT_PATH')
  }

  const rustBinaryPathRoot = config.isGCPFunction ? '/workspace' : '/home/site/wwwroot'
  const rustBinaryPathOsFolder = process.platform === 'win32'
    ? 'datadog-serverless-agent-windows-amd64'
    : 'datadog-serverless-agent-linux-amd64'

  const rustBinaryExtension = process.platform === 'win32' ? '.exe' : ''

  const rustBinaryPath =
    `${rustBinaryPathRoot}/node_modules/@datadog/sma/${rustBinaryPathOsFolder}/\
datadog-serverless-trace-mini-agent${rustBinaryExtension}`

  return rustBinaryPath
}

function getIsGCPFunction () {
  const isDeprecatedGCPFunction =
    getEnvironmentVariable('FUNCTION_NAME') !== undefined &&
    getEnvironmentVariable('GCP_PROJECT') !== undefined
  const isNewerGCPFunction =
    getEnvironmentVariable('K_SERVICE') !== undefined &&
    getEnvironmentVariable('FUNCTION_TARGET') !== undefined

  return isDeprecatedGCPFunction || isNewerGCPFunction
}

function getIsAzureFunction () {
  const isAzureFunction =
    getEnvironmentVariable('FUNCTIONS_EXTENSION_VERSION') !== undefined &&
    getEnvironmentVariable('FUNCTIONS_WORKER_RUNTIME') !== undefined

  return isAzureFunction
}

function isInServerlessEnvironment () {
  const inAWSLambda = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') !== undefined
  const isGCPFunction = getIsGCPFunction()
  const isAzureFunction = getIsAzureFunction()

  return inAWSLambda || isGCPFunction || isAzureFunction
}

module.exports = {
  maybeStartServerlessMiniAgent,
  getIsGCPFunction,
  getIsAzureFunction,
  getRustBinaryPath,
  isInServerlessEnvironment
}
