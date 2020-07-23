'use strict'

const log = require('../../log')
const { profiler, AgentExporter } = require('../../profiling')

let cached

module.exports = config => cached || (cached = {
  start: () => {
    const { service, version, env, url, hostname, port } = config
    const { enabled } = config.profiling
    const exporter = new AgentExporter({ url, hostname, port })
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
      exporters: [exporter]
    })
  },

  stop: () => {
    profiler.stop()
  }
})
