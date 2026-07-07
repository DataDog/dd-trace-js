'use strict'

const exporters = require('../../../../../ext/exporters')
const log = require('../../log')
const { LLMOBS_META_STRUCT_KEY } = require('../../llmobs/export-mode')

const ROUTE_TIMEOUT_MS = 60_000

/**
 * @typedef {{
 *   export: (spans: object[]) => void,
 *   flush?: (done?: () => void) => void,
 *   transferPendingTo?: (exporter: ApmExporter, exporterName?: string) => boolean,
 *   destroy?: () => void,
 * }} ApmExporter
 */

class DeferredApmExporter {
  #config
  #delegateExporter
  #destroyer
  #flushCallbacks = []
  #flushRequested = false
  #payloads = []
  #prioritySampler
  #routeTimeout

  /**
   * @param {import('../../config/config-base')} config
   * @param {import('../../priority_sampler')} prioritySampler
   */
  constructor (config, prioritySampler) {
    this.#config = config
    this.#prioritySampler = prioritySampler
    this._url = config.url

    this.#destroyer = this.flush.bind(this)
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(this.#destroyer)
  }

  /**
   * Buffers traces until LLMObs resolves whether APM traces should go through
   * the Agent or the agentless span intake.
   *
   * @param {object[]} spans
   * @returns {boolean}
   */
  export (spans) {
    if (this.#delegateExporter) {
      return this.#delegateExporter.export(spans)
    }

    this.#payloads.push(spans)
    return true
  }

  /**
   * @param {() => void} [done]
   * @returns {void}
   */
  flush (done = () => {}) {
    if (this.#delegateExporter) {
      this.#delegateExporter.flush(done)
      return
    }

    if (this.#payloads.length === 0) {
      done()
      return
    }

    this.#flushRequested = true
    this.#flushCallbacks.push(done)
    this.#keepAliveUntilRouteResolves()
  }

  /**
   * Moves buffered traces to the concrete exporter selected by the LLMObs Agent probe.
   *
   * @param {ApmExporter} exporter
   * @param {string | undefined} exporterName
   * @returns {boolean}
   */
  transferPendingTo (exporter, exporterName) {
    this.#transferDelegateTo(exporter)

    const payloads = this.#payloads
    this.#payloads = []
    this.#clearRouteTimeout()

    const shouldNormalizeForAgentless = exporterName === exporters.AGENTLESS

    for (const payload of payloads) {
      exporter.export(shouldNormalizeForAgentless ? normalizeLLMObsTagsForAgentless(payload) : payload)
    }

    this.#flushTransferredExporter(exporter)
    return true
  }

  /**
   * @returns {void}
   */
  destroy () {
    this.#clearRouteTimeout()
    this.#delegateExporter?.destroy?.()
    globalThis[Symbol.for('dd-trace')].beforeExitHandlers.delete(this.#destroyer)
  }

  /**
   * @returns {void}
   */
  #keepAliveUntilRouteResolves () {
    if (this.#routeTimeout !== undefined) return

    this.#routeTimeout = setTimeout(() => {
      log.warn(
        '[LLMObs] APM trace exporter route was not resolved before shutdown; sending buffered traces through %s.',
        this.#config.DD_API_KEY && this.#config.site ? 'agentless intake' : 'the Agent'
      )
      const exporterName = this.#config.DD_API_KEY && this.#config.site ? exporters.AGENTLESS : exporters.AGENT
      const Exporter = exporterName === exporters.AGENTLESS ? require('../agentless') : require('../agent')
      this.#delegateExporter = new Exporter(this.#config, this.#prioritySampler)
      this.transferPendingTo(this.#delegateExporter, exporterName)
    }, ROUTE_TIMEOUT_MS)
  }

  /**
   * @returns {void}
   */
  #clearRouteTimeout () {
    clearTimeout(this.#routeTimeout)
    this.#routeTimeout = undefined
  }

  /**
   * @param {ApmExporter} exporter
   * @returns {void}
   */
  #transferDelegateTo (exporter) {
    if (!this.#delegateExporter || this.#delegateExporter === exporter) return

    if (!this.#delegateExporter.transferPendingTo?.(exporter)) {
      this.#delegateExporter.flush?.(() => {})
    }
    this.#delegateExporter.destroy?.()
    this.#delegateExporter = undefined
  }

  /**
   * @param {ApmExporter} exporter
   * @returns {void}
   */
  #flushTransferredExporter (exporter) {
    if (!this.#flushRequested) return

    const callbacks = this.#flushCallbacks
    this.#flushCallbacks = []
    this.#flushRequested = false

    exporter.flush?.(() => {
      for (const callback of callbacks) {
        callback()
      }
    })
  }
}

/**
 * @param {object[]} trace
 * @returns {object[]}
 */
function normalizeLLMObsTagsForAgentless (trace) {
  for (const span of trace) {
    const tags = span.meta_struct?.[LLMOBS_META_STRUCT_KEY]?.tags
    if (tags === undefined) continue

    let normalizedTags
    for (const [key, value] of Object.entries(tags)) {
      const normalizedKey = key.replaceAll('.', '_')
      if (normalizedKey === key) continue

      normalizedTags ??= { ...tags }
      delete normalizedTags[key]
      normalizedTags[normalizedKey] = value
    }

    if (normalizedTags !== undefined) {
      span.meta_struct[LLMOBS_META_STRUCT_KEY].tags = normalizedTags
    }
  }

  return trace
}

module.exports = DeferredApmExporter
