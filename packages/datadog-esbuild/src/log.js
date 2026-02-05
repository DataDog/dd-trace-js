'use strict'

const { format } = require('util')

// eslint-disable-next-line eslint-rules/eslint-process-env
const DD_TRACE_DEBUG = (process.env.DD_TRACE_DEBUG || '').trim().toLowerCase()
const DEBUG = DD_TRACE_DEBUG === 'true' || DD_TRACE_DEBUG === '1'

const noop = () => {}

const formatWithLogPrefix = (prefix, str, ...args) => {
  if (typeof str === 'string') {
    return format(`${prefix} ${str}`, ...args)
  }
  return format(prefix, str, ...args)
}

module.exports = DEBUG
  ? {
      debug (...args) {
        // eslint-disable-next-line no-console
        console.log(formatWithLogPrefix('[dd-trace/esbuild]', ...args))
      },
      warn (...args) {
        // eslint-disable-next-line no-console
        console.warn(formatWithLogPrefix('[dd-trace/esbuild] Warning:', ...args))
      },
    }
  : {
      debug: noop,
      warn: noop,
    }
