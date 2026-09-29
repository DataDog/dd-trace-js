'use strict'

const { fetchAgentInfo } = require('../../agent/info')
const { getValueFromEnvSources } = require('../../config/helper')
const AgentExporter = require('../agent')
const AgentlessExporter = require('../agentless')
const BufferingExporter = require('../common/buffering-exporter')

/**
 * Buffers traces until LLMObs transport discovery selects either the Agent or
 * agentless APM exporter.
 */
class LLMObsExporter extends BufferingExporter {
  #exporter
  /** @type {Array<Function | undefined>} */
  #pendingFlushes = []
  #prioritySampler

  /**
   * @param {import('../../config/config-base')} config
   * @param {import('../../priority_sampler')} prioritySampler
   */
  constructor (config, prioritySampler) {
    super(config)
    this.#prioritySampler = prioritySampler
    this._url = undefined

    const agentlessEnabled = getValueFromEnvSources('DD_AGENTLESS_ENABLED', true)

    if (agentlessEnabled === undefined) {
      fetchAgentInfo(config.url, (err) => {
        this.#initialize(err != null)
      }, { retry: false })
    } else {
      this.#initialize(agentlessEnabled)
    }
  }

  /**
   *
   * @param {boolean} useAgentless
   */
  #initialize (useAgentless) {
    const Exporter = useAgentless ? AgentlessExporter : AgentExporter
    const pendingUrl = this._url
    this.#exporter = new Exporter(this._config, this.#prioritySampler)
    if (pendingUrl !== undefined) this.#exporter.setUrl?.(pendingUrl)
    this._url = this.#exporter._url

    this._isInitialized = true
    this.exportUncodedTraces()

    const pendingFlushes = this.#pendingFlushes
    this.#pendingFlushes = []
    for (const done of pendingFlushes) this.#exporter.flush(done)
  }

  /** @param {object[]} trace */
  export (trace) {
    if (!this._isInitialized) {
      this._traceBuffer.push(trace)
      return true
    }

    return this.#exporter.export(trace)
  }

  /** @param {Function} [done] */
  flush (done) {
    if (this._isInitialized) {
      this.#exporter.flush(done)
    } else {
      this.#pendingFlushes.push(done)
    }
  }

  /** @param {string | URL} url */
  setUrl (url) {
    if (this._isInitialized) {
      this.#exporter.setUrl?.(url)
      this._url = this.#exporter._url
    } else {
      this._url = url
    }
  }
}

module.exports = LLMObsExporter
