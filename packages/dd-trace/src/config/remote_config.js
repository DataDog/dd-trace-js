'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')

/**
 * Configures remote config for core APM tracing functionality
 *
 * @param {Object} rc - RemoteConfig instance
 * @param {Object} config - Tracer config
 * @param {Function} enableOrDisableTracing - Function to enable/disable tracing based on config
 */
function enable (rc, config, enableOrDisableTracing) {
  // Register core APM tracing capabilities
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)

  // APM_TRACING product handler - manages tracer configuration
  rc.setProductHandler('APM_TRACING', (action, conf) => {
    if (action === 'unapply') {
      config.configure({}, true)
    } else {
      config.configure(conf.lib_config, true)
    }
    enableOrDisableTracing(config, rc)
  })
}

module.exports = {
  enable
}
