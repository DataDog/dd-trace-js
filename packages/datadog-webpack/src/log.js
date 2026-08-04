'use strict'

const { format } = require('util')

const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')

const DEBUG = getValueFromEnvSources('DD_TRACE_DEBUG')

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
        console.log(formatWithLogPrefix('[dd-trace/webpack]', ...args))
      },
      warn (...args) {
        // eslint-disable-next-line no-console
        console.warn(formatWithLogPrefix('[dd-trace/webpack] Warning:', ...args))
      },
    }
  : {
      debug: noop,
      warn: noop,
    }
