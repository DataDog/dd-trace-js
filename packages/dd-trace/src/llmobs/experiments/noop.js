'use strict'

const log = require('../../log')
const { ExternalExperiment } = require('./experiment')

const NOOP_EXPERIMENT_ID = '00000000-0000-0000-0000-000000000000'
const NOOP_SPAN_ID = '0000000000000000'
const NOOP_TRACE_ID = '00000000000000000000000000000000'

class NoopDataset {
  #name
  #description
  #records
  #filterTags

  constructor (name = '', options = {}) {
    this.#name = name
    this.#description = typeof options === 'string' ? options : (options.description ?? '')
    this.#filterTags = typeof options === 'string' ? [] : [...(options.filterTags ?? [])]
    this.#records = (typeof options === 'string' ? [] : (options.records ?? [])).map(record => ({
      id: record.id ?? null,
      input: record.inputData,
      expectedOutput: record.expectedOutput ?? null,
      metadata: record.metadata ?? {},
      tags: [...(record.tags ?? [])],
    }))
  }

  addRecord (input, expectedOutput, metadata, tags) {
    this.#records.push({
      id: null,
      input,
      expectedOutput: expectedOutput ?? null,
      metadata: metadata ?? {},
      tags: [...(tags ?? [])],
    })
    return this
  }

  update (index, fields) {
    const record = this.#records[index]
    if (record == null) return this
    if (Object.hasOwn(fields, 'input')) record.input = fields.input
    if (Object.hasOwn(fields, 'expectedOutput')) record.expectedOutput = fields.expectedOutput ?? null
    if (Object.hasOwn(fields, 'metadata')) record.metadata = fields.metadata ?? {}
    return this
  }

  delete (index) {
    this.#records.splice(index, 1)
    return this
  }

  push () {
    return Promise.resolve({ pushedCount: 0, totalCount: 0 })
  }

  /**
   * Add tags to a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {NoopDataset} This dataset for chaining.
   */
  addTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    const normalizedTags = tags ?? []
    record.tags = [...new Set([...(record.tags ?? []), ...normalizedTags])].sort()
    return this
  }

  /**
   * Remove tags from a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {NoopDataset} This dataset for chaining.
   */
  removeTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    const normalizedTags = tags ?? []
    const removed = new Set(normalizedTags)
    record.tags = (record.tags ?? []).filter(tag => !removed.has(tag)).sort()
    return this
  }

  /**
   * Replace all tags on a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {NoopDataset} This dataset for chaining.
   */
  replaceTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    const normalizedTags = tags ?? []
    record.tags = [...normalizedTags]
    return this
  }

  name () {
    return this.#name
  }

  description () {
    return this.#description
  }

  id () {
    return null
  }

  projectId () {
    return null
  }

  version () {
    return null
  }

  latestVersion () {
    return null
  }

  /**
   * Return the tags used to filter this dataset.
   * @returns {string[]} Dataset record filter tags.
   */
  filterTags () {
    return [...this.#filterTags]
  }

  records () {
    return [...this.#records]
  }

  recordIds () {
    return []
  }

  url () {
    return null
  }
}

class NoopExperiment {
  #name
  #external

  constructor (name = '', external = false) {
    this.#name = name
    this.#external = external
  }

  name () {
    return this.#name
  }

  experimentId () {
    return this.#external ? NOOP_EXPERIMENT_ID : null
  }

  url () {
    return null
  }

  run () {
    return Promise.resolve({
      experimentId: null,
      rows: [],
      summaryEvaluations: {},
      runs: [],
      url: null,
    })
  }

  /**
   * @returns {Promise<{experimentId: string, spanId: string, traceId: string, url: null}>}
   */
  submitSpan () {
    return Promise.resolve({
      experimentId: NOOP_EXPERIMENT_ID,
      spanId: NOOP_SPAN_ID,
      traceId: NOOP_TRACE_ID,
      url: null,
    })
  }

  /**
   * @returns {Promise<void>}
   */
  submitEvaluationMetrics () {
    return Promise.resolve()
  }

  /**
   * @returns {Promise<void>}
   */
  close () {
    return Promise.resolve()
  }
}

// No-op Experiments used when LLM Observability is disabled or the API/APP keys
// are not configured. Operations warn and return inert objects rather than
// throwing, so intentionally disabled experiments remain graceful.
class NoopExperiments {
  #reason
  #startExperiment

  constructor (reason, options = {}) {
    this.#reason = reason || 'LLMObs experiments are not available'
    this.#startExperiment = options.startExperiment
  }

  #warn () {
    log.warn('LLMObs experiments unavailable: %s', this.#reason)
  }

  createDataset (name, options = {}) {
    this.#warn()
    return new NoopDataset(name, options)
  }

  pullDataset (name, options = {}) {
    this.#warn()
    return Promise.resolve(new NoopDataset(name, { filterTags: options.tags }))
  }

  experiment (options = {}) {
    this.#warn()
    return new NoopExperiment(options.name)
  }

  /**
   * @param {object} options
   * @returns {Promise<ExternalExperiment>}
   */
  startExperiment (options = {}) {
    if (this.#startExperiment !== undefined && options.projectName) {
      return this.#startExperiment(options)
    }

    this.#warn()
    return Promise.resolve(new ExternalExperiment(new NoopExperiment(options.name, true)))
  }
}

module.exports = NoopExperiments
