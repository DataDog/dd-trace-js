'use strict'

const logger = require('../../log')
const { EVP_PROXY_AGENT_BASE_PATH } = require('../constants/writers')

const AgentInfoExporter = require('../../exporters/common/agent-info-exporter')
/** @type {AgentInfoExporter} */
let agentInfoExporter

function setAgentStrategy (config, setWriterEnabledValue) {
  if (!agentInfoExporter) {
    agentInfoExporter = new AgentInfoExporter(config)
  }

  agentInfoExporter.getAgentInfo((err, agentInfo) => {
    if (err) {
      logger.debug('FFE Writer disabled - error getting agent info:', err.message)
      setWriterEnabledValue(false)
      return
    }

    const endpoints = agentInfo.endpoints
    const hasEndpoint = Array.isArray(endpoints) && endpoints.includes(EVP_PROXY_AGENT_BASE_PATH)

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
  setAgentStrategy
}
