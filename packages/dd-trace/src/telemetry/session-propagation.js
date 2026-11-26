'use strict'

const dc = /** @type {typeof import('diagnostics_channel')} */ (require('dc-polyfill'))
const { addChildProcessEnv } = require('../child-process-env')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

let subscribed = false
let savedConfig

function onChildProcessStart (context) {
  const runtimeId = savedConfig.DD_ROOT_JS_SESSION_ID || savedConfig.tags['runtime-id']
  addChildProcessEnv(context, { DD_ROOT_JS_SESSION_ID: runtimeId })
}

function start (config) {
  if (!config.telemetry.DD_INSTRUMENTATION_TELEMETRY_ENABLED || subscribed) return
  subscribed = true

  savedConfig = config

  childProcessChannel.subscribe(
    /** @type {import('diagnostics_channel').TracingChannelSubscribers<object>} */ ({ start: onChildProcessStart })
  )
}

module.exports = { start }
