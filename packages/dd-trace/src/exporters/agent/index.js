'use strict'

const Writer = require('./writer')

class AgentExporter {
  #timer

  constructor (config, prioritySampler) {
    this._config = config
    const { url, lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
    this._url = url

    const headers = {}
    if (stats.enabled || apmTracingEnabled === false) {
      headers['Datadog-Client-Computed-Stats'] = 'yes'
    }

    this._writer = new Writer({
      url: this._url,
      prioritySampler,
      lookup,
      protocolVersion,
      headers,
      config
    })

    process.once('beforeExit', () => {
      this.flush()
    })
  }

  setUrl (url) {
    this._url = url
    this._writer.setUrl(url)
  }

  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this._writer.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this._writer.flush(done)
  }
}

module.exports = AgentExporter
