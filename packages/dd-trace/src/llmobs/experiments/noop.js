'use strict'

const log = require('../../log')

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
      tags: record.tags ?? [],
    }))
  }

  addRecord (input, expectedOutput, metadata, tags) {
    this.#records.push({
      id: null,
      input,
      expectedOutput: expectedOutput ?? null,
      metadata: metadata ?? {},
      tags: tags ?? [],
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

  addTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    record.tags = [...new Set([...(record.tags ?? []), ...tags])].sort()
    return this
  }

  removeTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    const removed = new Set(tags)
    record.tags = (record.tags ?? []).filter(tag => !removed.has(tag)).sort()
    return this
  }

  replaceTags (index, tags) {
    const record = this.#records[index]
    if (!record) return this
    record.tags = [...tags]
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

  constructor (name = '') {
    this.#name = name
  }

  name () {
    return this.#name
  }

  experimentId () {
    return null
  }

  url () {
    return null
  }

  run () {
    return Promise.resolve({ experimentId: null, rows: [], url: null })
  }
}

// No-op Experiments used when LLM Observability is disabled or the API/APP keys
// are not configured. Operations warn and return inert objects rather than
// throwing, so intentionally disabled experiments remain graceful.
class NoopExperiments {
  #reason

  constructor (reason) {
    this.#reason = reason || 'LLMObs experiments are not available'
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
}

module.exports = NoopExperiments
