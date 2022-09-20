#!/usr/bin/env node

'use strict'

const childProcess = require('child_process')
const path = require('path')
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

const metaJson = require(path.join(process.cwd(), 'meta.json'))

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
    if (metaJson.variants) {
      const variants = metaJson.variants
      for (const variant in variants) {
        const variantEnv = Object.assign({}, env, { SIRUN_VARIANT: variant })
        await exec('sirun', ['meta.json'], { env: variantEnv, stdio: getStdio() })
      }
    } else {
      await exec('sirun', ['meta.json'], { env, stdio: getStdio() })
    }
  } catch (e) {
    setImmediate(() => {
      throw e // Older Node versions don't fail on uncaught promise rejections.
    })
  }
})()
