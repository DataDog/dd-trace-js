'use strict'

const logger = require('../../log')
const { EVP_PROXY_AGENT_BASE_PATH } = require('../constants/writers')
const { getAgentInfo } = require('../util')

function configureWriters (config, writers) {
  const { llmobs: { agentlessEnabled }, apiKey } = config

  // check if agentless is explicitly defined
  if (agentlessEnabled === false) {
    writers.forEach(writer => writer.setAgentless(false))
  } else if (agentlessEnabled === true && !apiKey) {
    throw new Error(
      'DD_API_KEY is required for sending LLMObs data when agentless mode is enabled. ' +
      'Ensure this configuration is set before running your application.'
    )
  } else if (agentlessEnabled === true) {
    writers.forEach(writer => writer.setAgentless(true))
  } else {
    // queue up a callback to configure the writers to agentless or agent-proxy
    getAgentInfo(config, (err, agentInfo) => {
      if (err && !apiKey) {
        throw new Error(
          'Cannot send LLM Observability data without a running agent and without a Datadog API key.\n' +
          'Please set DD_API_KEY and set DD_LLMOBS_AGENTLESS_ENABLED to true.'
        )
      } else if (err) {
        writers.forEach(writer => writer.setAgentless(true))
        return
      }

      const canSubmitToAgent =
        Array.isArray(agentInfo.endpoints) &&
        agentInfo.endpoints.some(endpoint => endpoint.includes(EVP_PROXY_AGENT_BASE_PATH))

      if (canSubmitToAgent) {
        writers.forEach(writer => writer.setAgentless(false))
      } else if (!apiKey) {
        throw new Error(
          'Cannot send LLM Observability data without a Datadog API key.\n' +
          'Please set DD_API_KEY.'
        )
      } else {
        logger.debug(
          '[LLMObs] Agent detected for data submission but agent version is incompatible with LLM Observability. ' +
          'LLM Observability data will be submitted via the Datadog API.'
        )
        writers.forEach(writer => writer.setAgentless(true))
      }
    })
  }
}

function parseResponseAndLog (err, code, eventsLength, url, eventType) {
  if (code === 403 && err.message.includes('API key is invalid')) {
    logger.error(
      '[LLMObs] The provided Datadog API key is invalid (likely due to an API key and DD_SITE mismatch). ' +
      'Please verify your API key and DD_SITE are correct.'
    )
  } else if (err) {
    logger.error(
      'Error sending %d LLMObs %s events to %s: %s', eventsLength, eventType, url, err.message, err
    )
  } else if (code >= 300) {
    logger.error(
      'Error sending %d LLMObs %s events to %s: %s', eventsLength, eventType, url, code
    )
  } else {
    logger.debug(`Sent ${eventsLength} LLMObs ${eventType} events to ${url}`)
  }
}

module.exports = {
  configureWriters,
  parseResponseAndLog
}
