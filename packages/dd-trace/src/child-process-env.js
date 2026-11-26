'use strict'

/**
 * Adds variables to the environment of a child process the child_process instrumentation is about
 * to spawn, by rewriting the arguments of the call in `context.callArgs`. The child gets the
 * environment the call passes, or this process's, plus `variables`.
 *
 * @param {{ callArgs?: unknown[], shell?: boolean }} context the start context of the
 *   `datadog:child_process:execution` tracing channel
 * @param {Record<string, string>} variables
 */
function addChildProcessEnv (context, variables) {
  const args = context.callArgs
  if (!args) return
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const getEnv = (env = process.env) => ({ ...env, ...variables })

  const index = Array.isArray(args[1]) || (!context.shell && !isOptionsObject(args[1])) ? 2 : 1
  const options = isOptionsObject(args[index]) ? args[index] : undefined

  if (options) {
    args[index] = { ...options, env: getEnv(options.env) }
    return
  }

  if (index === 2 && !Array.isArray(args[1])) {
    args.splice(1, 0, [])
  }

  const opts = { env: getEnv() }
  if (typeof args[index] === 'function') {
    args.splice(index, 0, opts)
  } else {
    args[index] = opts
  }
}

/**
 * @param {unknown} value
 */
function isOptionsObject (value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = { addChildProcessEnv }
