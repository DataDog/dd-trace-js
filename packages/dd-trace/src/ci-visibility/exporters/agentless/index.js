'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const CoverageWriter = require('./coverage-writer')
const Scheduler = require('../../../exporters/scheduler')

const log = require('../../../log')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    const { flushInterval, tags, site, url, isIntelligentTestRunnerEnabled } = config
    this._isIntelligentTestRunnerEnabled = isIntelligentTestRunnerEnabled

    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })

    this._coverageUrl = new URL(`https://event-platform-intake.${site}`)
    this._coverageWriter = new CoverageWriter({ url: this._coverageUrl })

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)

      if (this._isIntelligentTestRunnerEnabled) {
        this._coverageScheduler = new Scheduler(() => this._coverageWriter.flush())
      }
    }

    this._scheduler && this._scheduler.start()

    // Reduce likelihood of requests overlapping
    if (this._coverageScheduler) {
      setTimeout(() => {
        this._coverageScheduler.start()
      }, flushInterval / 2)
    }
  }

  exportCoverage ({ testSpan, coverageFiles }) {
    const formattedCoverage = {
      traceId: testSpan.context()._traceId,
      spanId: testSpan.context()._spanId,
      files: coverageFiles
    }
    this._coverageWriter.append(formattedCoverage)

    if (!this._coverageScheduler) {
      this._coverageWriter.flush()
    }
  }

  export (trace) {
    this._writer.append(trace)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }

  setUrl (url, coverageUrl = url) {
    try {
      url = new URL(url)
      coverageUrl = new URL(url)
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
