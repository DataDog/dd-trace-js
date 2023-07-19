'use strict'

function maybeStartServerlessMiniAgent (config) {
  const log = require('./log')

  let rustBinaryPath
  if (process.env.DD_MINI_AGENT_PATH !== undefined) {
    rustBinaryPath = process.env.DD_MINI_AGENT_PATH
  } else {
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      log.error(`Serverless Mini Agent is only supported on Windows and Linux.`)
      return
    }
    const rustBinaryPathRoot = config.isGCPFunction ? '/workspace' : '/home/site/wwwroot'
    const rustBinaryPathOsFolder =
      process.platform === 'win32' ? 'datadog-serverless-agent-windows-amd64' : 'datadog-serverless-agent-linux-amd64'
    rustBinaryPath =
      `${rustBinaryPathRoot}/node_modules/@datadog/sma/${rustBinaryPathOsFolder}/datadog-serverless-trace-mini-agent`
  }

  const fs = require('fs')

  // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
  // invalid paths and log our own error.
  if (!fs.existsSync(rustBinaryPath)) {
    log.error('Serverless Mini Agent did not start. Could not find mini agent binary.')
    return
  }
  try {
    require('child_process').spawn(rustBinaryPath, { stdio: 'inherit' })
  } catch (err) {
    log.error(`Error spawning mini agent process: ${err}`)
  }
}

function getIsAzureFunctionConsumptionPlan () {
  const isAzureFunction =
    process.env.FUNCTIONS_EXTENSION_VERSION !== undefined && process.env.FUNCTIONS_WORKER_RUNTIME !== undefined
  const azureWebsiteSKU = process.env.WEBSITE_SKU
  const isConsumptionPlan = azureWebsiteSKU === undefined || azureWebsiteSKU === 'Dynamic'

  return isAzureFunction && isConsumptionPlan
}

module.exports = { maybeStartServerlessMiniAgent, getIsAzureFunctionConsumptionPlan }
