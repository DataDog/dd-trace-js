'use strict'
const log = require('./log')
const fs = require('fs')

function maybeStartServerlessMiniAgent () {
  const isGCPFunction = process.env.K_SERVICE !== undefined || process.env.FUNCTION_NAME !== undefined
  const rustBinaryPath = process.env.DD_MINI_AGENT_PATH

  if (!isGCPFunction) {
    return
  }
  if (!rustBinaryPath) {
    log.error('Serverless Mini Agent did not start. Please provide a DD_MINI_AGENT_PATH environment variable.')
    return
  }

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
