'use strict'

const { URL, format } = require('url')
const log = require('../../log')
const Writer = require('./writer')

class AgentExporter {
  #timer

  constructor (config, prioritySampler) {
    this._config = config
    const { url, hostname, port, lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
    this._url = url || new URL(format({
      protocol: 'http:',
      hostname: hostname || 'localhost',
      port
    }))

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
    try {
      url = new URL(url)
      this._url = url
      this._writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
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
