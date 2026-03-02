'use strict'

const logger = require('../../log')
const { EVP_PROXY_AGENT_BASE_PATH } = require('../constants/constants')
const { fetchAgentInfo } = require('../../agent/info')
const { getAgentUrl } = require('../../agent/url')

/**
 * Determines if the agent supports EVP proxy and sets the writer enabled state accordingly
 * @param {import('../../config')} config - Tracer configuration object
 * @param {Function} setWriterEnabledValue - Callback to set the writer enabled state
 */
function setAgentStrategy (config, setWriterEnabledValue) {
  fetchAgentInfo(getAgentUrl(config), (err, agentInfo) => {
    if (err) {
      logger.debug('FFE Writer disabled - error getting agent info:', err.message)
      setWriterEnabledValue(false)
      return
    }

    const endpoints = agentInfo.endpoints
    const normalizedPath = EVP_PROXY_AGENT_BASE_PATH.replace(/\/+$/, '')
    const hasEndpoint = Array.isArray(endpoints) &&
      endpoints.includes(normalizedPath) || endpoints.includes(normalizedPath + '/')

    if (hasEndpoint) {
      logger.debug('FFE Writer enabled - agent has EVP proxy support')
      setWriterEnabledValue(true)
    } else {
      logger.debug('FFE Writer disabled - agent does not have EVP proxy support')
      setWriterEnabledValue(false)
    }
  })
}

module.exports = {
  setAgentStrategy,
}
