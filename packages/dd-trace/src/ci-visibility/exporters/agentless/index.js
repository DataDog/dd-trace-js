'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const Scheduler = require('../../../exporters/scheduler')

const log = require('../../../log')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    const { flushInterval, tags, site, url, isITREnabled } = config
    this._isITREnabled = isITREnabled
    this._url = url || new URL(`https://citestcycle-intake.${site}`)

    const coverageUrl = new URL(`https://event-platform-intake.${site}`)

    this._writer = new Writer({ url: this._url, tags, coverageUrl })

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)

      if (this._isITREnabled) {
        this._coverageScheduler = new Scheduler(() => this._writer.flushCoverage())
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
    this._writer.appendCoverage(formattedCoverage)

    if (!this._coverageScheduler) {
      this._writer.flushCoverage()
    }
  }

  export (trace) {
    this._writer.append(trace)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
  }

  flush () {
    this._writer.flush()
  }
}

module.exports = AgentlessCiVisibilityExporter
