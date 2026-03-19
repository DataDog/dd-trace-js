'use strict'

const dc = require('dc-polyfill')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

let subscribed = false
let rootSessionId
let runtimeId

function injectSessionEnv (existingEnv) {
  // eslint-disable-next-line eslint-rules/eslint-process-env -- not in supported-configurations.json
  const base = existingEnv == null ? process.env : existingEnv
  return {
    ...base,
    DD_ROOT_JS_SESSION_ID: rootSessionId,
    DD_PARENT_JS_SESSION_ID: runtimeId,
  }
}

function findOptionsIndex (args, shell) {
  if (Array.isArray(args[1])) {
    return { index: 2, exists: args[2] != null && typeof args[2] === 'object' }
  }
  if (args[1] != null && typeof args[1] === 'object') {
    return { index: 1, exists: true }
  }
  return { index: shell ? 1 : 2, exists: false }
}

function onChildProcessStart (context) {
  if (!context.callArgs) return

  const args = context.callArgs
  const { index, exists } = findOptionsIndex(args, context.shell)

  if (exists) {
    args[index] = { ...args[index], env: injectSessionEnv(args[index].env) }
    return
  }

  const opts = { env: injectSessionEnv(null) }

  if (!context.shell && !Array.isArray(args[1])) {
    args.splice(1, 0, [])
  }

  if (typeof args[index] === 'function') {
    args.splice(index, 0, opts)
  } else {
    args[index] = opts
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

module.exports = { start, _onChildProcessStart: onChildProcessStart }
