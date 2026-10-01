#!/usr/bin/env node

'use strict'

const { exec, stdio, VARIANT_TIMEOUT_MS } = require('./run-util')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

const env = { ...process.env, DD_TRACE_STARTUP_LOGS: 'false' }

exec('sirun', ['meta-temp.json'], { env, stdio, timeoutMs: VARIANT_TIMEOUT_MS }).catch(error => {
  process.stderr.write(error.message + '\n')
  process.exitCode = error.code === 'ETIMEDOUT' ? 124 : 1
})
