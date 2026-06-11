'use strict'

const Plugin = require('./plugin')

class LogPlugin extends Plugin {
  configure (config) {
    return super.configure({
      ...config,
      enabled: config.enabled && (config.logInjection || config.DD_AGENTLESS_LOG_SUBMISSION_ENABLED),
    })
  }
}

module.exports = LogPlugin
