'use strict'

const log = require('../../log')
const { profiler, AgentExporter, FileExporter } = require('../../profiling')

let cached

module.exports = config => cached || (cached = {
  start: () => {
    const { service, version, env } = config
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
      exporters: getExporters(exporters, config)
    })
  },

  stop: () => {
    profiler.stop()
  }
})

function getExporters (names, { url, hostname, port }) {
  const exporters = []

  for (const name of names.split(',')) {
    switch (name) {
      case 'agent':
        exporters.push(new AgentExporter({ url, hostname, port }))
        break
      case 'file':
        exporters.push(new FileExporter())
        break
    }
  }

  return exporters
}
