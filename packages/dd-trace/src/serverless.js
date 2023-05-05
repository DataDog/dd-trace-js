'use strict'

function maybeStartServerlessMiniAgent () {
  let rustBinaryPath =
    '/workspace/node_modules/@datadog/sma/datadog-serverless-agent-linux-amd64/datadog-serverless-trace-mini-agent'
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
      log.info(data.toString())
    })
    miniAgentProcess.on('close', (code) => {
      log.error(`Mini Agent exited with code ${code}`)
    })
    miniAgentProcess.on('error', (err) => {
      log.error(err.toString())
    })
  } catch (err) {
    log.error(`Error spawning mini agent process: ${err}`)
  }
}

module.exports = { maybeStartServerlessMiniAgent }
