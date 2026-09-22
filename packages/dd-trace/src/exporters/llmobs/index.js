'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { LLMOBS_META_STRUCT_KEY } = require('../../llmobs/constants/tags')
const { setAgentStrategy } = require('../../llmobs/writers/util')
const AgentExporter = require('../agent')
const AgentlessExporter = require('../agentless')
const BufferingExporter = require('../common/buffering-exporter')

const spanAppendCh = channel('llmobs:span:append')

/**
 * Buffers traces until LLMObs transport discovery selects either the Agent or
 * agentless APM exporter.
 */
class LLMObsExporter extends BufferingExporter {
  #exporter
  #pendingEvents = new WeakMap()
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

    let accepted = false
    try {
      accepted = this.#exporter.export(trace) !== false
    } catch (error) {
      log.error('Error exporting an LLMObs APM trace: %s', error.message, error)
    }

    this.#finishTrace(trace, accepted)
    return accepted
  }

  /**
   * Retains the direct-intake representation until its APM trace is accepted.
   * @param {import('../../opentracing/span')} span
   * @param {object} event
   * @param {{ apiKey?: string, site?: string }} routing
   */
  registerLlmobsEvent (span, event, routing) {
    this.#pendingEvents.set(span.meta_struct[LLMOBS_META_STRUCT_KEY], { span, event, routing })
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

  /**
   * @param {object[]} trace
   * @param {boolean} accepted
   */
  #finishTrace (trace, accepted) {
    for (const span of trace) {
      const key = span.meta_struct?.[LLMOBS_META_STRUCT_KEY]
      if (!key) continue

      const pending = this.#pendingEvents.get(key)
      if (!pending) continue

      this.#pendingEvents.delete(key)
      if (!accepted) spanAppendCh.publish(pending)
    }
  }
}

module.exports = LLMObsExporter
