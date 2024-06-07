#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const { exec, getStdio } = require('./run-util')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

require('./squash-affinity')

const metaJson = require(path.join(process.cwd(), 'meta.json'))
const env = Object.assign({}, process.env, { DD_TRACE_STARTUP_LOGS: 'false' })

;(async () => {
  try {
    if (metaJson.variants) {
      const variants = metaJson.variants
      for (const variant in variants) {
        const variantEnv = Object.assign({}, env, { SIRUN_VARIANT: variant })
        await exec('sirun', ['meta-temp.json'], { env: variantEnv, stdio: getStdio() })
      }
    } else {
      await exec('sirun', ['meta-temp.json'], { env, stdio: getStdio() })
    }

    try {
      fs.unlinkSync(path.join(process.cwd(), 'meta-temp.json'))
    } catch (e) {
      // it's ok if we can't delete a temp file
    }
  } catch (e) {
    setImmediate(() => {
      throw e // Older Node versions don't fail on uncaught promise rejections.
    })
  }
})()
