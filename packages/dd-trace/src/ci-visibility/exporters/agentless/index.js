'use strict'

const URL = require('url').URL
const Writer = require('./writer')

class AgentlessCiVisibilityExporter {
  constructor (config) {
    this._config = config
    const { tags, site, url } = config
    this._url = url || new URL(`https://citestcycle-intake.${site}`)
    this._writer = new Writer({ url: this._url, tags })
    this._timer = undefined

    process.once('beforeExit', () => this._writer.flush())
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
}

module.exports = AgentlessCiVisibilityExporter
