'use strict'

const URL = require('url').URL
const Writer = require('./writer')
const Scheduler = require('../../../exporters/scheduler')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    const { flushInterval, tags, site, url, isITREnabled } = config
    this._isITREnabled = isITREnabled
    this._url = url || new URL(`https://citestcycle-intake.${site}`)

    const coverageUrl = new URL(`https://event-platform-intake.${site}`)

    this._writer = new Writer({ url: this._url, tags, coverageUrl }, isITREnabled)

    if (flushInterval > 0) {
      this._scheduler = new Scheduler(() => {
        this._writer.flush()
        if (this._isITREnabled) {
          this._writer.flushCoverage()
        }
      }, flushInterval)
    }

    this._scheduler && this._scheduler.start()
  }

  exportCoverage ({ coverage, span }) {
    if (this._isITREnabled) {
      this._writer.appendCoverage({ coverage, span })

      if (!this._scheduler) {
        this._writer.flush()
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
