'use strict'

const log = require('./log')
const { profiler } = require('./profiling')

module.exports = {
  start: config => {
    const { service, version, env, url, hostname, port, tags } = config
    const { enabled, sourceMap, exporters } = config.profiling
    const logger = {
      debug: (message) => log.debug(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message)
    }

    profiler.start({
      enabled,
      service,
      version,
      env,
      logger,
      sourceMap,
      exporters,
      url,
      hostname,
      port,
      tags
    })
  },

  stop: () => {
    profiler.stop()
  }
}
