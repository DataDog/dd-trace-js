'use strict'

const { fetchAgentInfo } = require('../../agent/info')
const { getValueFromEnvSources } = require('../../config/helper')
const { LLMOBS_META_STRUCT_KEY } = require('../../llmobs/constants/tags')
const logger = require('../../log')
const AgentExporter = require('../agent')
const AgentlessExporter = require('../agentless')
const BufferingExporter = require('../common/buffering-exporter')

const MAX_BUFFERED_SPANS = 1000

/**
 * Buffers traces until LLMObs transport discovery selects either the Agent or
 * agentless APM exporter.
 */
class LLMObsExporter extends BufferingExporter {
  #agentless = false
  #bufferLimitWarned = false
  #bufferedSpanCount = 0
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

    const globalAgentlessEnabled = getValueFromEnvSources('DD_AGENTLESS_ENABLED', true)
    const agentlessEnabled = globalAgentlessEnabled ?? config.llmobs.DD_LLMOBS_AGENTLESS_ENABLED

    if (agentlessEnabled === undefined) {
      fetchAgentInfo(config.url, (err) => {
        this.#initialize(err != null)
      }, { keepProcessAlive: true })
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
    this.#agentless = useAgentless
    this.#exporter = new Exporter(this._config, this.#prioritySampler)
    if (pendingUrl !== undefined) this.#exporter.setUrl?.(pendingUrl)
    this._url = this.#exporter._url

    this._isInitialized = true
    this.exportUncodedTraces()
    this.#bufferedSpanCount = 0

    const pendingFlushes = this.#pendingFlushes
    this.#pendingFlushes = []
    for (const done of pendingFlushes) this.#exporter.flush(done)
  }

  /** @param {object[]} trace */
  export (trace) {
    if (!this._isInitialized) {
      if (trace.length > MAX_BUFFERED_SPANS) {
        this.#warnBufferLimit()
        return false
      }

      if (this.#bufferedSpanCount + trace.length > MAX_BUFFERED_SPANS) this.#warnBufferLimit()
      while (this.#bufferedSpanCount + trace.length > MAX_BUFFERED_SPANS) {
        this.#bufferedSpanCount -= this._traceBuffer.shift().length
      }

      this._traceBuffer.push(trace)
      this.#bufferedSpanCount += trace.length
      return true
    }

    if (this.#agentless) this.#normalizeTagKeys(trace)
    return this.#exporter.export(trace)
  }

  #warnBufferLimit () {
    if (this.#bufferLimitWarned) return

    this.#bufferLimitWarned = true
    logger.warn('LLMObs exporter trace buffer full (limit is %d spans), dropping trace data', MAX_BUFFERED_SPANS)
  }

  /** @param {object[]} trace */
  #normalizeTagKeys (trace) {
    for (const span of trace) {
      const llmobs = span.meta_struct?.[LLMOBS_META_STRUCT_KEY]
      if (!llmobs?.tags) continue

      const tags = {}
      for (const [key, value] of Object.entries(llmobs.tags)) {
        tags[key.replaceAll('.', '_')] = value
      }
      llmobs.tags = tags
    }
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
