'use strict'

const { URL } = require('url')
const log = require('../../log')
const PendingOperations = require('../common/pending-operations')
const Writer = require('./writer')

class AgentExporter {
  #timer
  #operations = new PendingOperations()

  constructor (config, prioritySampler) {
    this._config = config
    const { lookup, protocolVersion, stats = {}, apmTracingEnabled } = config
    this._url = config.url

    const headers = {}
    if (stats.DD_TRACE_STATS_COMPUTATION_ENABLED || apmTracingEnabled === false) {
      headers['Datadog-Client-Computed-Stats'] = 'yes'
    }

    this._writer = new Writer({
      url: this._url,
      prioritySampler,
      lookup,
      protocolVersion,
      headers,
      onFlush: this.#operations.track.bind(this.#operations),
    })

    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.flush.bind(this))
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
      this.#flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#flush()
        this.#timer = undefined
      }, flushInterval)
      this.#timer.unref?.()
    }
  }

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined

    try {
      this.#flush()
    } catch (error) {
      log.error('Failed to flush traces: %s', error)
    }

    return this.#operations.wait(done)
  }

  #flush () {
    const complete = this.#operations.start()
    try {
      this._writer.flushDirect(complete)
    } catch (error) {
      complete()
      throw error
    }
  }
}

module.exports = AgentExporter
