#!/usr/bin/env node

'use strict'

const childProcess = require('child_process')
const readline = require('readline')

process.env.DD_TRACE_TELEMETRY_ENABLED = 'false'

function exec (...args) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(...args)
    streamAddVersion(proc.stdout)
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('Process exited with non-zero code.'))
      }
    })
  })
}

const env = Object.assign({}, process.env, { DD_TRACE_STARTUP_LOGS: 'false' })

function streamAddVersion (input) {
  input.rl = readline.createInterface({ input })
  input.rl.on('line', function (line) {
    try {
      const json = JSON.parse(line.toString())
      json.nodeVersion = process.versions.node
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(json))
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(line)
    }
  })
}

function getStdio () {
  return ['inherit', 'pipe', 'inherit']
}

(async () => {
  try {
    await exec('sirun', ['meta-temp.json'], { env, stdio: getStdio() })
  } catch (e) {
    setImmediate(() => {
      throw e // Older Node versions don't fail on uncaught promise rejections.
    })
  }
})()
