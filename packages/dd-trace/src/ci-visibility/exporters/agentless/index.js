'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const CoverageWriter = require('./coverage-writer')
const CiVisibilityExporter = require('../ci-visibility-exporter')
const log = require('../../../log')

class AgentlessCiVisibilityExporter extends CiVisibilityExporter {
  constructor (config) {
    super(config)
    const { tags, site, url, isTestDynamicInstrumentationEnabled } = config
    // we don't need to request /info because we are using agentless by configuration
    this._isInitialized = true
    this._resolveCanUseCiVisProtocol(true)
    this._canForwardLogs = true

    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })

    this._coverageUrl = url || new URL(`https://citestcov-intake.${site}`)
    this._coverageWriter = new CoverageWriter({ url: this._coverageUrl })

    if (isTestDynamicInstrumentationEnabled) {
      const DynamicInstrumentationLogsWriter = require('./di-logs-writer')
      this._logsUrl = url || new URL(`https://http-intake.logs.${site}`)
      this._logsWriter = new DynamicInstrumentationLogsWriter({ url: this._logsUrl, tags })
    }

    this._apiUrl = url || new URL(`https://api.${site}`)
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
