'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const CoverageWriter = require('./coverage-writer')

const log = require('../../../log')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    this._config = config
    const { tags, site, url, isIntelligentTestRunnerEnabled } = config
    this._isIntelligentTestRunnerEnabled = isIntelligentTestRunnerEnabled
    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })
    this._timer = undefined
    this._coverageTimer = undefined

    this._coverageUrl = url || new URL(`https://event-platform-intake.${site}`)
    this._coverageWriter = new CoverageWriter({ url: this._coverageUrl })

    process.once('beforeExit', () => {
      this._writer.flush()
      this._coverageWriter.flush()
    })
  }

  exportCoverage ({ testSpan, coverageFiles }) {
    const formattedCoverage = {
      traceId: testSpan.context()._traceId,
      spanId: testSpan.context()._spanId,
      files: coverageFiles
    }
    this._coverageWriter.append(formattedCoverage)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._coverageWriter.flush()
    } else if (flushInterval > 0 && !this._coverageTimer) {
      this._coverageTimer = setTimeout(() => {
        this._coverageWriter.flush()
        this._coverageTimer = clearTimeout(this._coverageTimer)
      }, flushInterval).unref()
    }
  }

  export (trace) {
    this._writer.append(trace)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (flushInterval > 0 && !this._timer) {
      this._timer = setTimeout(() => {
        this._writer.flush()
        this._timer = clearTimeout(this._timer)
      }, flushInterval).unref()
    }
  }

  setUrl (url, coverageUrl = url) {
    try {
      url = new URL(url)
      coverageUrl = new URL(coverageUrl)
      this._url = url
      this._coverageUrl = coverageUrl
      this._writer.setUrl(url)
      this._coverageWriter.setUrl(coverageUrl)
    } catch (e) {
      log.error(e)
    }
  }
}

module.exports = AgentlessCiVisibilityExporter
