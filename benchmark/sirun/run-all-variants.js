#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const { exec, stdio, VARIANT_TIMEOUT_MS } = require('./run-util')
const { prepareMetaFile } = require('./squash-affinity')
const { verifySirunVersion } = require('./verify-sirun-version')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

verifySirunVersion()
prepareMetaFile()

const metaJson = require(path.join(process.cwd(), 'meta.json'))
const env = { ...process.env, DD_TRACE_STARTUP_LOGS: 'false' }

;(async () => {
  if (metaJson.variants) {
    const variants = metaJson.variants
    for (const variant in variants) {
      const variantEnv = { ...env, SIRUN_VARIANT: variant }
      await exec('sirun', ['meta-temp.json'], { env: variantEnv, stdio, timeoutMs: VARIANT_TIMEOUT_MS })
    }
  } else {
    await exec('sirun', ['meta-temp.json'], { env, stdio, timeoutMs: VARIANT_TIMEOUT_MS })
  }

  try {
    fs.unlinkSync(path.join(process.cwd(), 'meta-temp.json'))
  } catch {
    // it's ok if we can't delete a temp file
  }
})().catch(error => {
  process.stderr.write(error.message + '\n')
  process.exitCode = error.code === 'ETIMEDOUT' ? 124 : 1
})
