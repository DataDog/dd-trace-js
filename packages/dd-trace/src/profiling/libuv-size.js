'use strict'

const { getEnvironmentVariable } = require('../config-helper')
const os = require('node:os')

function getLibuvThreadPoolSize (envVar) {
  if (envVar === undefined) {
    return
  }
  // libuv uses atoi to parse the value, which is almost the same as parseInt, except that parseInt
  // will return NaN on invalid input, while atoi will return 0. This is handled at return.
  const s = Number.parseInt(envVar, 10)
  // We don't interpret the value further here in the library. Backend will interpret the number
  // based on Node version.
  return Number.isNaN(s) ? 0 : s
}

const libuvThreadPoolSize = getLibuvThreadPoolSize(getEnvironmentVariable('UV_THREADPOOL_SIZE'))

function getEffectiveLibuvThreadCount (size) {
  // In all currently known Node versions, 0 results in 1 worker thread, negative values (because
  // they're assigned to an unsigned int) become very high positive values, and the value is finally
  // capped at 1024.
  if (size === undefined) {
    return 4
  } else if (size < 0 || size > 1024) {
    return 1024
  } else if (size === 0) {
    return 1
  }
  return size
}

const effectiveLibuvThreadCount = getEffectiveLibuvThreadCount(libuvThreadPoolSize)

function availableParallelism () {
  // os.availableParallelism only available in node 18.14.0/19.4.0 and above
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
}

module.exports = {
  availableParallelism,
  effectiveLibuvThreadCount,
  libuvThreadPoolSize,
  // Only used for testing
  getLibuvThreadPoolSize,
  getEffectiveLibuvThreadCount
}
