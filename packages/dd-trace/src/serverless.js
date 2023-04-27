'use strict'

// In Google Cloud Functions, there is no overlap between env vars set by older deprecated runtimes newer
// runtimes.
// https://cloud.google.com/functions/docs/configuring/env-var#runtime_environment_variables_set_automatically
function inGCPFunction () {
  const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined
  return isDeprecatedGCPFunction || isNewerGCPFunction
}

function maybeStartServerlessMiniAgent () {
  if (!inGCPFunction()) {
    return
  }

  let rustBinaryPath =
    '/workspace/node_modules/datadog-sma/datadog-serverless-agent-linux-amd64/datadog-serverless-trace-mini-agent'
  if (process.env.DD_MINI_AGENT_PATH !== undefined) {
    rustBinaryPath = process.env.DD_MINI_AGENT_PATH
  }
  const log = require('./log')
  const fs = require('fs')

  // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
  // invalid paths and log our own error.
  if (!fs.existsSync(rustBinaryPath)) {
    log.error('Serverless Mini Agent did not start. Could not find mini agent binary.')
    return
  }
  try {
    const { spawn } = require('child_process')
    const miniAgentProcess = spawn(rustBinaryPath)
    miniAgentProcess.stdout.on('data', (data) => {
      log.debug(data.toString())
    })
    miniAgentProcess.on('close', (code) => {
      log.error(`Mini Agent exited with code ${code}`)
    })
    miniAgentProcess.on('error', (err) => {
      log.error(`Mini Agent errored out: ${err}`)
    })
  } catch (err) {
    log.error(`Error spawning mini agent process: ${err}`)
  }
}

module.exports = {
  inGCPFunction,
  maybeStartServerlessMiniAgent
}
