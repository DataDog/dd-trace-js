'use strict'

const { URL } = require('url')
const log = require('../../log')
const { getAgentUrl } = require('../../agent/url')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #config
  #url
  #writer

  constructor (config, prioritySampler) {
    this.#config = config
    const { lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
    this.#url = getAgentUrl(config)

    const headers = {}
    if (stats.enabled || apmTracingEnabled === false) {
      headers['Datadog-Client-Computed-Stats'] = 'yes'
    }

    this.#writer = new Writer({
      url: this.#url,
      prioritySampler,
      lookup,
      protocolVersion,
      headers,
      config,
    })

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.flush.bind(this))
  }

  setUrl (url) {
    try {
      url = new URL(url)
      this.#url = url
      this.#writer.setUrl(url)
    } catch (e) {
      log.warn(e.stack)
    }
  }

  export (spans) {
    this.#writer.append(spans)

    const { flushInterval } = this.#config

    if (flushInterval === 0) {
      this.#writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#writer.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#writer.flush(done)
  }
}

module.exports = AgentExporter
