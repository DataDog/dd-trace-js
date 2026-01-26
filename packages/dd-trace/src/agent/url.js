'use strict'

const { URL, format } = require('url')
const defaults = require('../config/defaults')

module.exports = { getAgentUrl }

// TODO: Investigate merging with the getAgentUrl function in config/index.js which has
// additional logic for unix socket auto-detection on Linux. The config version is only used
// during config initialization, while this one is used throughout the codebase. Consider if
// the unix socket detection should be part of this general helper or remain config-specific.

/**
 * Gets the agent URL from config, constructing it from hostname/port if needed
 * @param {ReturnType<import('../config')>} config - Tracer configuration object
 * @returns {URL} The agent URL
 */
function getAgentUrl (config) {
  const { url, hostname = defaults.hostname, port = defaults.port } = config
  return url || new URL(format({
    protocol: 'http:',
    hostname,
    port
  }))
}
