'use strict'
const log = require('./log')

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
