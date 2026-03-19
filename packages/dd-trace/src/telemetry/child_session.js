'use strict'

const shimmer = require('../../../datadog-shimmer')

let patched = false

function injectSessionEnv (existingEnv, rootSessionId, runtimeId) {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const base = existingEnv == null ? process.env : existingEnv
  return {
    ...base,
    DD_ROOT_JS_SESSION_ID: rootSessionId,
    DD_PARENT_JS_SESSION_ID: runtimeId,
  }
}

function wrapSpawnLike (original, rootSessionId, runtimeId) {
  return function () {
    const args = [...arguments]
    if (Array.isArray(args[1])) {
      // method(file, argsArray, [options])
      const opts = args[2] != null && typeof args[2] === 'object' ? args[2] : {}
      args[2] = { ...opts, env: injectSessionEnv(opts.env, rootSessionId, runtimeId) }
    } else if (args[1] != null && typeof args[1] === 'object') {
      // method(file, options)
      args[1] = { ...args[1], env: injectSessionEnv(args[1].env, rootSessionId, runtimeId) }
    } else {
      // method(file) — no args array, no options
      args[1] = []
      args[2] = { env: injectSessionEnv(null, rootSessionId, runtimeId) }
    }
    return original.apply(this, args)
  }
}

function start (config) {
  if (patched) return
  patched = true

  const rootSessionId = config.rootSessionId
  const runtimeId = config.tags['runtime-id']

  const childProcess = require('child_process')
  for (const method of ['spawn', 'spawnSync', 'fork']) {
    shimmer.wrap(childProcess, method, original => wrapSpawnLike(original, rootSessionId, runtimeId))
  }
}

module.exports = { start }
