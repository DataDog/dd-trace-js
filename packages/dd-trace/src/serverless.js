'use strict'

function maybeStartServerlessMiniAgent () {
  const isDeprecatedGCPFunction = process.env.FUNCTION_NAME !== undefined && process.env.GCP_PROJECT !== undefined
  const isNewerGCPFunction = process.env.K_SERVICE !== undefined && process.env.FUNCTION_TARGET !== undefined
  const inGCPFunction = isDeprecatedGCPFunction || isNewerGCPFunction

  const rustBinaryPath = process.env.DD_MINI_AGENT_PATH

  if (!inGCPFunction) {
    return
  }

  const log = require('./log')
  if (!rustBinaryPath) {
    log.error('Serverless Mini Agent did not start. Please provide a DD_MINI_AGENT_PATH environment variable.')
    return
  }

  const fs = require('fs')

  // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
  // invalid paths and log our own error.
  if (!fs.existsSync(rustBinaryPath)) {
    log.error('Serverless Mini Agent did not start. DD_MINI_AGENT_PATH points to a non-existent file.')
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
  maybeStartServerlessMiniAgent
}
