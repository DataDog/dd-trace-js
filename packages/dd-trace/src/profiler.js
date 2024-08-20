'use strict'

const log = require('./log')
const { profiler } = require('./profiling')

// Stop profiler upon exit in order to collect and export the current profile
process.once('beforeExit', () => { profiler.stop() })

module.exports = {
  start: config => {
    const { service, version, env, url, hostname, port, tags, repositoryUrl, commitSHA, injectionEnabled } = config
    const { enabled, sourceMap, exporters } = config.profiling
    const logger = {
      debug: (message) => log.debug(message),
      info: (message) => log.info(message),
      warn: (message) => log.warn(message),
      error: (message) => log.error(message)
    }

    const libraryInjected = injectionEnabled.length > 0
    let activation
    if (enabled === 'auto') {
      activation = 'auto'
    } else if (enabled === 'true') {
      activation = 'manual'
    } else if (injectionEnabled.includes('profiler')) {
      activation = 'injection'
    } // else activation = undefined

    return profiler.start({
      service,
      version,
      env,
      logger,
      sourceMap,
      exporters,
      url,
      hostname,
      port,
      tags,
      repositoryUrl,
      commitSHA,
      libraryInjected,
      activation
    })
  },

  stop: () => {
    profiler.stop()
  }
}
