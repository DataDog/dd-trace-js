'use strict'

const URL = require('url').URL
const CiVisibilityExporter = require('../ci-visibility-exporter')
const log = require('../../../log')
const Writer = require('./writer')
const CoverageWriter = require('./coverage-writer')

class AgentlessCiVisibilityExporter extends CiVisibilityExporter {
  constructor (config) {
    super(config)
    const { tags, site, ciVisibilityAgentlessUrl, isTestDynamicInstrumentationEnabled } = config
    // we don't need to request /info because we are using agentless by configuration
    this._isInitialized = true
    this._resolveCanUseCiVisProtocol(true)
    this._canForwardLogs = true

    this._url = ciVisibilityAgentlessUrl || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })

    this._coverageUrl = ciVisibilityAgentlessUrl || new URL(`https://citestcov-intake.${site}`)
    this._coverageWriter = new CoverageWriter({ url: this._coverageUrl })

    this._codeCoverageReportUrl = ciVisibilityAgentlessUrl || new URL(`https://ci-intake.${site}`)

    if (isTestDynamicInstrumentationEnabled) {
      const DynamicInstrumentationLogsWriter = require('./di-logs-writer')
      this._logsUrl = ciVisibilityAgentlessUrl || new URL(`https://http-intake.logs.${site}`)
      this._logsWriter = new DynamicInstrumentationLogsWriter({ url: this._logsUrl, tags })
    }

    this._apiUrl = ciVisibilityAgentlessUrl || new URL(`https://api.${site}`)
    // Agentless is always gzip compatible
    this._isGzipCompatible = true
  }

  setUrl (url, coverageUrl = url, apiUrl = url) {
    this._setUrl(url, coverageUrl)
    try {
      apiUrl = new URL(apiUrl)
      this._apiUrl = apiUrl
    } catch (e) {
      log.error('Error setting CI exporter api url', e)
    }
  }

  _getApiUrl () {
    return this._apiUrl
  }
}

module.exports = AgentlessCiVisibilityExporter
