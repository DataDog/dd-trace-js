'use strict'

const dc = require('dc-polyfill')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

let subscribed = false
let rootSessionId
let runtimeId

function injectSessionEnv (existingEnv) {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const base = existingEnv == null ? process.env : existingEnv
  return {
    ...base,
    DD_ROOT_JS_SESSION_ID: rootSessionId,
    DD_PARENT_JS_SESSION_ID: runtimeId,
  }
}

function onChildProcessStart (context) {
  if (!context.callArgs) return

  const args = context.callArgs
  if (Array.isArray(args[1])) {
    // method(file, argsArray, [options])
    const opts = args[2] != null && typeof args[2] === 'object' ? args[2] : {}
    args[2] = { ...opts, env: injectSessionEnv(opts.env) }
  } else if (args[1] != null && typeof args[1] === 'object') {
    // method(file, options)
    args[1] = { ...args[1], env: injectSessionEnv(args[1].env) }
  } else if (context.shell) {
    // execSync(command) — shell command with no options
    args[1] = { env: injectSessionEnv(null) }
  } else {
    // spawn(file) / fork(file) — no args array, no options
    args[1] = []
    args[2] = { env: injectSessionEnv(null) }
  }
}

function start (config) {
  if (!config.telemetry?.enabled || subscribed) return
  subscribed = true

  rootSessionId = config.rootSessionId
  runtimeId = config.tags['runtime-id']

  childProcessChannel.subscribe({
    start: onChildProcessStart,
  })
}

module.exports = { start }
