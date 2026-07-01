'use strict'

const { API_BASE_PATH } = require('./client')

// Immutable dataset record: { input, expectedOutput?, metadata? }.
class DatasetRecord {
  constructor (input, expectedOutput = null, metadata = {}) {
    this.input = input
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
  }
}

// A local buffer of dataset records, created remotely and pushed on first run
// (or eagerly via push()). Pushes are incremental.
class Dataset {
  #client
  #name
  #description
  #records
  #recordIds
  #id
  #projectId
  #pushedCount

  constructor (client, name, description = '') {
    this.#client = client
    this.#name = name
    this.#description = description
    this.#records = []
    this.#recordIds = []
    this.#id = null
    this.#projectId = null
    this.#pushedCount = 0
  }

  // Build a Dataset that already exists remotely (used by pullDataset).
  static fromExisting (client, name, description, id, projectId, records, recordIds) {
    const dataset = new Dataset(client, name, description)
    dataset.#id = id
    dataset.#projectId = projectId
    dataset.#records.push(...records)
    dataset.#recordIds.push(...recordIds)
    dataset.#pushedCount = records.length
    return dataset
  }

  // Append a record. Accepts a DatasetRecord or (input, expectedOutput?, metadata?).
  addRecord (recordOrInput, expectedOutput, metadata) {
    const record = recordOrInput instanceof DatasetRecord
      ? recordOrInput
      : new DatasetRecord(recordOrInput, expectedOutput, metadata)
    this.#records.push(record)
    return this
  }

  name () {
    return this.#name
  }

  records () {
    return [...this.#records]
  }

  recordIds () {
    return [...this.#recordIds]
  }

  id () {
    return this.#id
  }

  projectId () {
    return this.#projectId
  }

  // Dashboard URL for this dataset, or null until pushed/pulled.
  url () {
    if (this.#id === null) return null
    return `${this.#client.appBase}/llm/datasets/${this.#id}`
  }

  // Eagerly create the dataset (if needed) and push any unpushed records.
  async push () {
    const projectId = await this.#client.ensureProjectId()
    await this.ensureCreatedAndPushed(projectId)
  }

  // Create the remote dataset if needed, then push records added since the last
  // push. Idempotent and incremental.
  async ensureCreatedAndPushed (projectId) {
    if (this.#id === null) {
      let response
      try {
        response = await this.#client.request('POST', `${API_BASE_PATH}/${projectId}/datasets`, {
          data: { type: 'datasets', attributes: { name: this.#name, description: this.#description } },
        })
      } catch (err) {
        throw new Error(`Failed to create dataset '${this.#name}': ${err.message}`)
      }
      this.#id = response?.data?.id ?? null
      this.#projectId = projectId
    }

    if (this.#pushedCount >= this.#records.length) return

    const pending = this.#records.slice(this.#pushedCount)
    const records = pending.map((rec) => {
      const out = { input: rec.input }
      if (rec.expectedOutput !== null && rec.expectedOutput !== undefined) {
        out.expected_output = rec.expectedOutput
      }
      if (rec.metadata && Object.keys(rec.metadata).length > 0) {
        out.metadata = rec.metadata
      }
      return out
    })

    // W1: the records POST must send type "datasets".
    let response
    try {
      response = await this.#client.request(
        'POST',
        `${API_BASE_PATH}/${projectId}/datasets/${this.#id}/records`,
        { data: { type: 'datasets', attributes: { records } } }
      )
    } catch (err) {
      throw new Error(`Failed to push records to dataset '${this.#name}': ${err.message}`)
    }

    const data = response?.data
    if (Array.isArray(data)) {
      for (const node of data) {
        this.#recordIds.push(String(node?.id ?? ''))
      }
    } else {
      for (let i = 0; i < pending.length; i++) this.#recordIds.push('')
    }

    this.#pushedCount = this.#records.length
  }
}

module.exports = { Dataset, DatasetRecord }
