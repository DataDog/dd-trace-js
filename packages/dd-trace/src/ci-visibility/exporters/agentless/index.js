'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const CoverageWriter = require('./coverage-writer')
const Scheduler = require('../../../exporters/scheduler')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    const { flushInterval, tags, site, url, isITREnabled } = config
    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => this._writer.flush(), flushInterval)
    }

    if (isITREnabled) {
      const coverageUrl = new URL(`https://event-platform-intake.${site}`)
      this._coverageWriter = new CoverageWriter({ url: coverageUrl, tags })
      if (flushInterval > 0) {
        this._coverageScheduler = new Scheduler(() => this._coverageWriter.flush(), flushInterval)
      }
    }

    this._scheduler && this._scheduler.start()
    this._coverageScheduler && this._coverageScheduler.start()
  }

  exportCoverage ({ coverage, span }) {
    if (this._coverageWriter) {
      this._coverageWriter.append({ span, coverage })

      if (!this._coverageScheduler) {
        this._coverageWriter.flush()
      }
    }
  }

  export (trace) {
    this._writer.append(trace)

    if (!this._scheduler) {
      this._writer.flush()
    }
  }

  flush () {
    this._writer.flush()
  }
}

module.exports = AgentlessCiVisibilityExporter
