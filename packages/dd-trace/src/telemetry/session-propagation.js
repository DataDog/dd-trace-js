'use strict'

const dc = /** @type {typeof import('diagnostics_channel')} */ (require('dc-polyfill'))
const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

let subscribed = false
let runtimeId

function isOptionsObject (value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && value
}

function getEnvWithRuntimeId (env) {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  return { ...(env ?? process.env), DD_ROOT_JS_SESSION_ID: runtimeId }
}

function onChildProcessStart (context) {
  const args = context.callArgs
  if (!args) return

  const index = Array.isArray(args[1]) || (!context.shell && !isOptionsObject(args[1])) ? 2 : 1
  const options = isOptionsObject(args[index]) ? args[index] : undefined

  if (options) {
    args[index] = { ...options, env: getEnvWithRuntimeId(options.env) }
    return
  }

  if (index === 2 && !Array.isArray(args[1])) {
    args.splice(1, 0, [])
  }

  const opts = { env: getEnvWithRuntimeId() }
  if (typeof args[index] === 'function') {
    args.splice(index, 0, opts)
  } else {
    args[index] = opts
  }
}

function start (config) {
  if (!config.telemetry?.enabled || subscribed) return
  subscribed = true

  runtimeId = config.DD_ROOT_JS_SESSION_ID || config.tags['runtime-id']

  childProcessChannel.subscribe(
    /** @type {import('diagnostics_channel').TracingChannelSubscribers<object>} */ ({ start: onChildProcessStart })
  )
}

module.exports = { start }
