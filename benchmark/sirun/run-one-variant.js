#!/usr/bin/env node

'use strict'

const { exec, getStdio } = require('./run-util')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

const env = Object.assign({}, process.env, { DD_TRACE_STARTUP_LOGS: 'false' })

;(async () => {
  try {
    await exec('sirun', ['meta-temp.json'], { env, stdio: getStdio() })
  } catch (e) {
    setImmediate(() => {
      throw e // Older Node versions don't fail on uncaught promise rejections.
    })
  }
})()
