'use strict'

const AgentWriter = require('../../../exporters/agent/writer')
const AgentlessWriter = require('../agentless/writer')
const CoverageWriter = require('../agentless/coverage-writer')
const CiVisibilityExporter = require('../ci-visibility-exporter')
const request = require('../request')
const { fetchAgentInfo } = require('../../../agent/info')
const { DEBUGGER_INPUT_V1 } = require('../../../debugger/constants')

// Product-specific discovery: newest advertised version, skip v3 (citestcycle), gzip if >= v4.
// Shared `evp_proxy` discovery is an explicit path allowlist and does not cover this contract.
const AGENT_EVP_PROXY_PATH_PREFIX = '/evp_proxy/v'
const AGENT_EVP_PROXY_PATH_REGEX = /\/evp_proxy\/v(\d+)\/?/

function getLatestEvpProxyVersion (err, agentInfo) {
  if (err) {
    return 0
  }
  return agentInfo.endpoints.reduce((acc, endpoint) => {
    if (endpoint.includes(AGENT_EVP_PROXY_PATH_PREFIX)) {
      const version = Number(endpoint.replace(AGENT_EVP_PROXY_PATH_REGEX, '$1'))
      if (Number.isNaN(version)) {
        return acc
      }
      return Math.max(version, acc)
    }
    return acc
  }, 0)
}

function getCanForwardDebuggerLogs (err, agentInfo) {
  return !err && agentInfo.endpoints.includes(DEBUGGER_INPUT_V1)
}

class AgentProxyCiVisibilityExporter extends CiVisibilityExporter {
  constructor (config) {
    super(config)

    const {
      tags,
      prioritySampler,
      lookup,
      protocolVersion,
      headers,
      testOptimization,
    } = config

    const initializationController = new AbortController()
    const initializationOptions = { signal: initializationController.signal }
    this._initializationRequest = {
      controller: initializationController,
      options: initializationOptions,
    }

    fetchAgentInfo(this._url, (err, agentInfo) => {
      this._initializationRequest = undefined
      const initializationAborted = initializationController.signal.aborted
      const agentInfoError = err || (initializationAborted ? initializationController.signal.reason : undefined)

      this._isInitialized = true
      let latestEvpProxyVersion = getLatestEvpProxyVersion(agentInfoError, agentInfo)
      const isEvpCompatible = latestEvpProxyVersion >= 2
      this._isGzipCompatible = latestEvpProxyVersion >= 4

      // v3 does not work well citestcycle, so we downgrade to v2
      if (latestEvpProxyVersion === 3) {
        latestEvpProxyVersion = 2
      }

      const evpProxyPrefix = `${AGENT_EVP_PROXY_PATH_PREFIX}${latestEvpProxyVersion}`
      if (isEvpCompatible) {
        this._isUsingEvpProxy = true
        this.evpProxyPrefix = evpProxyPrefix
        this._writer = new AgentlessWriter({
          url: this._url,
          tags,
          evpProxyPrefix,
        })
        this._coverageWriter = new CoverageWriter({
          url: this._url,
          evpProxyPrefix,
        })
        this._codeCoverageReportUrl = this._url
        // Screenshot media uploads go through the Agent's evp_proxy: the uploader prefixes the
        // path with evpProxyPrefix and sets X-Datadog-EVP-Subdomain: api (see uploadTestScreenshot).
        this._testScreenshotUploadUrl = this._url
        if (testOptimization.DD_TEST_FAILED_TEST_REPLAY_ENABLED) {
          const canFowardLogs = getCanForwardDebuggerLogs(agentInfoError, agentInfo)
          if (canFowardLogs) {
            const DynamicInstrumentationLogsWriter = require('../agentless/di-logs-writer')
            this._logsWriter = new DynamicInstrumentationLogsWriter({
              url: this._url,
              isAgentProxy: true,
            })
            this._canForwardLogs = true
          }
        }
      } else {
        this._writer = new AgentWriter({
          url: this._url,
          prioritySampler,
          lookup,
          protocolVersion,
          headers,
          isTestOptimization: true,
        })
        // coverages will never be used, so we discard them
        this._coverageBuffer = []
      }
      this._resolveCanUseCiVisProtocol(isEvpCompatible)
      if (initializationAborted) {
        this.resetUncodedTraces()
        return
      }
      this.exportUncodedTraces()
      this.exportUncodedCoverages()
    }, initializationOptions, request)
  }

  setUrl (url, coverageUrl) {
    this._setUrl(url, coverageUrl)
  }
}

module.exports = AgentProxyCiVisibilityExporter
