'use strict'

const log = require('../../log')
const { profiler, AgentExporter } = require('../../profiling')

module.exports = config => ({
  start: () => {
    const { service, version, env, url, hostname, port } = config
    const { enabled } = config.profiling
    const exporter = new AgentExporter({ url, hostname, port })
    const logger = {
      debug: (message) => log.debug(message),
      warn: (message) => log.debug(message),
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
