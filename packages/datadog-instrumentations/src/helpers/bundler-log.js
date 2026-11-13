'use strict'

const { format } = require('node:util')

const noop = () => {}

/**
 * @param {string} name
 * @returns {import('./bundler-utils').BundlerLog}
 */
function createBundlerLog (name) {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const debug = (process.env.DD_TRACE_DEBUG || '').trim().toLowerCase()
  if (debug !== 'true' && debug !== '1') return { debug: noop, warn: noop }

  const prefix = `[dd-trace/${name}]`
  return {
    debug (...args) {
      // eslint-disable-next-line no-console
      console.log(formatWithLogPrefix(prefix, ...args))
    },
    warn (...args) {
      // eslint-disable-next-line no-console
      console.warn(formatWithLogPrefix(`${prefix} Warning:`, ...args))
    },
  }
}

/**
 * @param {string} prefix
 * @param {unknown} [str]
 * @param {...unknown} args
 */
function formatWithLogPrefix (prefix, str, ...args) {
  return typeof str === 'string' ? format(`${prefix} ${str}`, ...args) : format(prefix, str, ...args)
}

module.exports = createBundlerLog
