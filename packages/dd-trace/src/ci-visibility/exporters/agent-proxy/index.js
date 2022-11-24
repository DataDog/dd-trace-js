'use strict'

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')
const AgentInfoExporter = require('../../../exporters/common/exporter-agent-info')
const log = require('../../../log')

const AGENT_EVP_PROXY_PATH = '/evp_proxy/v2'

/**
 * AgentProxyCiVisibilityExporter extends from AgentInfoExporter
 * to get the agent information. If the agent is event platform proxy compatible,
 * it will initialise the CI Visibility writers.
 * If it isn't, it will fall back to the agent writer.
 */
class AgentProxyCiVisibilityExporter extends AgentInfoExporter {
  constructor (config) {
    super(config)

    this.coverageBuffer = []

    this.getAgentInfo((err, agentInfo) => {
      let isEvpCompatible = false
      const { tags, prioritySampler, lookup, protocolVersion, headers } = config
      if (err) {
        isEvpCompatible = false
      } else {
        const {
          endpoints
        } = agentInfo
        isEvpCompatible = endpoints.some(url => url.includes(AGENT_EVP_PROXY_PATH))
      }

      if (isEvpCompatible) {
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
        this.coverageBuffer = []
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

  exportUncodedCoverages () {
    this.coverageBuffer.forEach(oldCoveragePayload => {
      this.exportCoverage(oldCoveragePayload)
    })
    this.coverageBuffer = []
  }

  exportCoverage ({ span, coverageFiles }) {
    // until we know what writer to use, we just store coverage payloads
    if (!this._coverageWriter) {
      this.coverageBuffer.push({ span, coverageFiles })
      return
    }
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
