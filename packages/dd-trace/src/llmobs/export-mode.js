'use strict'

const exporters = require('../../../../ext/exporters')

const LLMOBS_META_STRUCT_KEY = '_llmobs'
const CACHED_LLMOBS_EVENT_SYMBOL = Symbol('dd.llmobs.event')

const LLMObsExportMode = {
  APM_AGENT: 'apm_agent',
  APM_AGENTLESS: 'apm_agentless',
  LLMOBS_AGENT_PROXY: 'llmobs_agent_proxy',
  LLMOBS_AGENTLESS: 'llmobs_agentless',
}

/**
 * Determines the LLMObs span-event submission path for the current tracer config.
 *
 * @param {import('../config/config-base')} config
 * @param {import('./writers/spans') | null} [writer]
 * @returns {string}
 */
function getLLMObsExportMode (config, writer) {
  if (config?.DD_TRACE_ENABLED !== true || config?.apmTracingEnabled !== true) {
    return getLLMObsWriterExportMode(config, writer)
  }

  if (config.OTEL_TRACES_EXPORTER === 'otlp' && !config.isCiVisibility) {
    return getLLMObsWriterExportMode(config, writer)
  }

  const exporter = config.experimental?.exporter
  if (exporter === exporters.AGENTLESS ||
      config.llmobs?.agentlessEnabled === true ||
      writer?._agentless === true) {
    return LLMObsExportMode.APM_AGENTLESS
  }
  if (exporter === undefined ||
      exporter === '' ||
      exporter === exporters.AGENT ||
      exporter === exporters.DEFERRED) {
    return LLMObsExportMode.APM_AGENT
  }

  return getLLMObsWriterExportMode(config, writer)
}

/**
 * Returns the concrete writer transport mode for LLMObs span events.
 *
 * @param {import('../config/config-base')} config
 * @param {import('./writers/spans') | null} [writer]
 * @returns {string}
 */
function getLLMObsWriterExportMode (config, writer) {
  if (writer?._agentless === true ||
      config?.llmobs?.agentlessEnabled === true) {
    return LLMObsExportMode.LLMOBS_AGENTLESS
  }

  return LLMObsExportMode.LLMOBS_AGENT_PROXY
}

/**
 * @param {string} mode
 * @returns {boolean}
 */
function isLLMObsWriterExportMode (mode) {
  return mode === LLMObsExportMode.LLMOBS_AGENT_PROXY || mode === LLMObsExportMode.LLMOBS_AGENTLESS
}

module.exports = {
  CACHED_LLMOBS_EVENT_SYMBOL,
  LLMOBS_META_STRUCT_KEY,
  LLMObsExportMode,
  getLLMObsExportMode,
  getLLMObsWriterExportMode,
  isLLMObsWriterExportMode,
}
