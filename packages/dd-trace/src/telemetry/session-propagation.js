'use strict'

const dc = require('dc-polyfill')

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

let subscribed = false
let rootSessionId
let runtimeId

function injectSessionEnv (existingEnv) {
  // eslint-disable-next-line eslint-rules/eslint-process-env -- internal env propagation, not a user-facing config
  const base = existingEnv == null ? process.env : existingEnv
  return {
    ...base,
    DD_ROOT_JS_SESSION_ID: rootSessionId,
    DD_PARENT_JS_SESSION_ID: runtimeId,
  }
}

function getArgShape (args, shell) {
  if (Array.isArray(args[1])) return 'argsArray'
  if (args[1] != null && typeof args[1] === 'object') return 'options'
  if (shell) return 'shell'
  if (typeof args[1] === 'function') return 'callback'
  return 'fileOnly'
}

function onChildProcessStart (context) {
  if (!context.callArgs) return

  const args = context.callArgs
  switch (getArgShape(args, context.shell)) {
    case 'argsArray': {
      // method(file, argsArray, [options], [cb])
      const optsIdx = 2
      if (args[optsIdx] != null && typeof args[optsIdx] === 'object') {
        args[optsIdx] = { ...args[optsIdx], env: injectSessionEnv(args[optsIdx].env) }
      } else {
        // No options object — insert one before any trailing callback
        const env = { env: injectSessionEnv(null) }
        if (typeof args[optsIdx] === 'function') {
          args.splice(optsIdx, 0, env)
        } else {
          args[optsIdx] = env
        }
      }
      break
    }
    case 'options':
      // method(file, options, [cb])
      args[1] = { ...args[1], env: injectSessionEnv(args[1].env) }
      break
    case 'shell':
      // execSync(command) — shell command with no options
      args[1] = { env: injectSessionEnv(null) }
      break
    case 'callback':
      // execFile(file, cb) — insert options before the callback
      args.splice(1, 0, { env: injectSessionEnv(null) })
      break
    case 'fileOnly':
      // spawn(file) / fork(file) — no args array, no options, no callback
      args[1] = []
      args[2] = { env: injectSessionEnv(null) }
      break
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

module.exports = { start, _onChildProcessStart: onChildProcessStart, _getArgShape: getArgShape }
