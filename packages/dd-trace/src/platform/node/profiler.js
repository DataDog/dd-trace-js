'use strict'

const log = require('../../log')
const { profiler, AgentExporter } = require('../../profiling')

module.exports = function () {
  return {
    start: () => {
      const { service, version, env, url, hostname, port } = this._config
      const { enabled } = this._config.profiling
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
        loggers: [logger],
        exporters: [exporter]
      })
    },

    stop: () => {
      profiler.stop()
    }
  }
}
