'use strict'

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')
const CiVisibilityExporter = require('../ci-visibility-exporter')

const AGENT_EVP_PROXY_PATH = '/evp_proxy/v2'

function getIsEvpCompatible (err, agentInfo) {
  return !err && agentInfo.endpoints.some(url => url.includes(AGENT_EVP_PROXY_PATH))
}

class AgentProxyCiVisibilityExporter extends CiVisibilityExporter {
  constructor (config) {
    super(config)

    const {
      tags,
      prioritySampler,
      lookup,
      protocolVersion,
      headers
    } = config

    this.getAgentInfo((err, agentInfo) => {
      this._isInitialized = true
      const isEvpCompatible = getIsEvpCompatible(err, agentInfo)
      if (isEvpCompatible) {
        this._isUsingEvpProxy = true
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
      this._resolveCanUseCiVisProtocol(isEvpCompatible)
      this.exportUncodedTraces()
      this.exportUncodedCoverages()
    })
  }

  setUrl (url, coverageUrl) {
    this._setUrl(url, coverageUrl)
  }
}

module.exports = AgentProxyCiVisibilityExporter
