'use strict'

const logger = require('../../log')
const { EVP_PROXY_PATH_V2 } = require('../../evp_proxy/constants')
const { discoverEVPProxy } = require('../../evp_proxy/discovery')

/**
 * Determines if the agent supports EVP proxy and sets the writer enabled state accordingly
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 */
function setAgentStrategy (config, setWriterEnabledValue) {
  discoverEVPProxy(config.url, {
    supportedPaths: [EVP_PROXY_PATH_V2],
  }, (err, route) => {
    if (err) {
      logger.debug('FFE Writer disabled - error getting agent info: %s', err.message)
      setWriterEnabledValue(false)
      return
    }

    if (route) {
      logger.debug('FFE Writer enabled - agent has EVP proxy support')
      setWriterEnabledValue(true, route)
    } else {
      logger.debug('FFE Writer disabled - agent does not have EVP proxy support')
      setWriterEnabledValue(false)
    }
  })
}

module.exports = {
  setAgentStrategy,
}
