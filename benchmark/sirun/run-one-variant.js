#!/usr/bin/env node

'use strict'

const { exec, getStdio } = require('./run-util')

process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'

const env = Object.assign({}, process.env, { DD_TRACE_STARTUP_LOGS: 'false' })

exec('sirun', ['meta-temp.json'], { env, stdio: getStdio() })
