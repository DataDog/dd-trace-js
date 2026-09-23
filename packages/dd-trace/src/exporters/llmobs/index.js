'use strict'

const { setAgentStrategy } = require('../../llmobs/writers/util')
const AgentExporter = require('../agent')
const AgentlessExporter = require('../agentless')
const BufferingExporter = require('../common/buffering-exporter')

/**
 * Buffers traces until LLMObs transport discovery selects either the Agent or
 * agentless APM exporter.
 */
class LLMObsExporter extends BufferingExporter {
  #exporter
  #prioritySampler

  /**
   * @param {import('../../config/config-base')} config
   * @param {import('../../priority_sampler')} prioritySampler
   */
  constructor (config, prioritySampler) {
    super(config)
    this.#prioritySampler = prioritySampler
    this._url = undefined

    setAgentStrategy(config, (useAgentless, agentAvailable) => {
      const useAgent = agentAvailable ?? !useAgentless
      const Exporter = useAgent ? AgentExporter : AgentlessExporter

      // Preserve a setUrl() call made while agent discovery was pending.
      const pendingUrl = this._url
      this.#exporter = new Exporter(this._config, this.#prioritySampler)
      if (pendingUrl !== undefined) this.#exporter.setUrl?.(pendingUrl)
      this._url = this.#exporter._url

      this._isInitialized = true
      this.exportUncodedTraces()
    })
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
    if (this._isInitialized) this.#exporter.flush(done)
    else done?.()
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
