'use strict'

const logger = require('../../log')
const { EVP_PROXY_AGENT_BASE_PATH } = require('../constants/writers')
const telemetry = require('../telemetry')

const AgentInfoExporter = require('../../exporters/common/agent-info-exporter')
/** @type {AgentInfoExporter} */
let agentInfoExporter

function setAgentStrategy (config, setWritersAgentlessValue) {
  const agentlessEnabled = config.llmobs.agentlessEnabled

  if (agentlessEnabled != null) {
    setWritersAgentlessValue(agentlessEnabled)
    return
  }

  if (!agentInfoExporter) {
    agentInfoExporter = new AgentInfoExporter(config)
  }

  agentInfoExporter.getAgentInfo((err, agentInfo) => {
    if (err) {
      setWritersAgentlessValue(true)
      return
    }

    const endpoints = agentInfo.endpoints
    const hasEndpoint = Array.isArray(endpoints) && endpoints.includes(EVP_PROXY_AGENT_BASE_PATH)
    setWritersAgentlessValue(!hasEndpoint)
  })
}

function parseResponseAndLog (err, code, eventsLength, url, eventType) {
  if (code === 403 && err.message.includes('API key is invalid')) {
    logger.error(
      '[LLMObs] The provided Datadog API key is invalid (likely due to an API key and DD_SITE mismatch). ' +
      'Please verify your API key and DD_SITE are correct.'
    )
    telemetry.recordDroppedPayload(eventsLength, eventType, 'request_error')
  } else if (err) {
    logger.error(
      'Error sending %d LLMObs %s events to %s: %s', eventsLength, eventType, url, err.message, err
    )
    telemetry.recordDroppedPayload(eventsLength, eventType, 'request_error')
  } else if (code >= 300) {
    logger.error(
      'Error sending %d LLMObs %s events to %s: %s', eventsLength, eventType, url, code
    )
    telemetry.recordDroppedPayload(eventsLength, eventType, 'http_error')
  } else {
    logger.debug(`Sent ${eventsLength} LLMObs ${eventType} events to ${url}`)
  }
}

module.exports = {
  setAgentStrategy,
  parseResponseAndLog
}
