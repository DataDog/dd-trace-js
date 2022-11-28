'use strict'

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')
const AgentInfoExporter = require('../../../exporters/common/agent-info-exporter')
const log = require('../../../log')

const AGENT_EVP_PROXY_PATH = '/evp_proxy/v2'

function getIsEvpCompatible (err, agentInfo) {
  return !err && agentInfo.endpoints.some(url => url.includes(AGENT_EVP_PROXY_PATH))
}

const getIsTestSessionTrace = (trace) => {
  return trace.some(span =>
    span.type === 'test_session_end' || span.type === 'test_suite_end'
  )
}

/**
 * AgentProxyCiVisibilityExporter extends from AgentInfoExporter
 * to get the agent information. If the agent is event platform proxy compatible,
 * it will initialize the CI Visibility writers.
 * If it isn't, it will fall back to the agent writer.
 */
class AgentProxyCiVisibilityExporter extends AgentInfoExporter {
  constructor (config) {
    super(config)

    this._coverageBuffer = []
    const { tags, prioritySampler, lookup, protocolVersion, headers } = config
    this._isInitialized = false

    this.getAgentInfo((err, agentInfo) => {
      this._isInitialized = true
      this._isEvpCompatible = getIsEvpCompatible(err, agentInfo)
      if (this._isEvpCompatible) {
        this._writer = new AgentlessWriter({
          url: this._url,
          tags,
          evpProxyPrefix: AGENT_EVP_PROXY_PATH
        })
        this._coverageWriter = new CoverageWriter({
          url: this._url,
          evpProxyPrefix: AGENT_EVP_PROXY_PATH
        })
      } else {
        this._writer = new AgentWriter({
          url: this._url,
          prioritySampler,
          lookup,
          protocolVersion,
          headers
        })
        // coverages will never be used, so we discard them
        this._coverageBuffer = []
      }
      this.exportUncodedTraces()
      this.exportUncodedCoverages()
    })

    process.once('beforeExit', () => {
      if (this._writer) {
        this._writer.flush()
      }
      if (this._coverageWriter) {
        this._coverageWriter.flush()
      }
    })
  }

  exportUncodedTraces () {
    this.getUncodedTraces().forEach(uncodedTrace => {
      this.export(uncodedTrace)
    })
    this.resetUncodedTraces()
  }

  exportUncodedCoverages () {
    this._coverageBuffer.forEach(oldCoveragePayload => {
      this.exportCoverage(oldCoveragePayload)
    })
    this._coverageBuffer = []
  }

  /**
   * TODO: add test to check that suite traces are not being processed if
   * evp is not compatible
   */

  export (trace) {
    // Until it's initialized, we just store the traces as is
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return
    }
    if (!this._isEvpCompatible && getIsTestSessionTrace(trace)) {
      return
    }
    this._export(trace)
  }

  /**
   * TODO: add test to check that suite traces are not being processed if
   * evp is not compatible
   */
  exportCoverage (coveragePayload) {
    // Until it's initialized, we just store the coverages as is
    if (!this._isInitialized) {
      this._coverageBuffer.push(coveragePayload)
      return
    }
    // We can't process coverages if it's not evp compatible
    if (!this._isEvpCompatible) {
      return
    }

    const { span, coverageFiles } = coveragePayload
    const formattedCoverage = {
      traceId: span.context()._traceId,
      spanId: span.context()._spanId,
      files: coverageFiles
    }

    this._export(formattedCoverage, this._coverageWriter, '_coverageTimer')
  }

  setUrl (url, coverageUrl = url) {
    super.setUrl(url)
    try {
      if (this._coverageWriter) {
        coverageUrl = new URL(coverageUrl)
        this._coverageUrl = coverageUrl
        this._coverageWriter.setUrl(coverageUrl)
      }
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = AgentProxyCiVisibilityExporter
