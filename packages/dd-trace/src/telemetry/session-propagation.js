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

/**
 * Finds the index of the options object in callArgs, or determines
 * where one should be inserted. Returns { index, exists }.
 *
 * child_process methods have these signatures:
 *   spawn(file, [args], [options])
 *   execFile(file, [args], [options], [cb])
 *   fork(file, [args], [options])
 *   execSync(command, [options])
 */
function findOptionsIndex (args, shell) {
  if (Array.isArray(args[1])) {
    // (file, argsArray, ...) — options slot is index 2
    return { index: 2, exists: args[2] != null && typeof args[2] === 'object' }
  }
  if (args[1] != null && typeof args[1] === 'object') {
    // (file, options, ...) — options already at index 1
    return { index: 1, exists: true }
  }
  // No args array and no options object — options should go at index 1 for shell
  // commands, or index 2 for non-shell (after an empty args array we'll insert)
  return { index: shell ? 1 : 2, exists: false }
}

function onChildProcessStart (context) {
  if (!context.callArgs) return

  const args = context.callArgs
  const { index, exists } = findOptionsIndex(args, context.shell)

  if (exists) {
    args[index] = { ...args[index], env: injectSessionEnv(args[index].env) }
  } else {
    const opts = { env: injectSessionEnv(null) }

    // For non-shell commands without an args array, insert an empty one first
    if (!context.shell && !Array.isArray(args[1])) {
      args.splice(1, 0, [])
    }

    // Insert options before any trailing callback to preserve call semantics
    if (typeof args[index] === 'function') {
      args.splice(index, 0, opts)
    } else {
      args[index] = opts
    }
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
