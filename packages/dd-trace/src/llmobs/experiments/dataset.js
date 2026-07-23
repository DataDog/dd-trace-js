'use strict'

const { API_BASE_PATH } = require('./client')

// Immutable dataset record: { input, expectedOutput?, metadata?, id? }.
class DatasetRecord {
  constructor (input, expectedOutput = null, metadata = {}, id = null) {
    this.input = input
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
    this.id = id ?? null
  }
}

function createdRecordsFromResponse (response) {
  if (Array.isArray(response?.records)) return response.records
  if (Array.isArray(response?.data)) return response.data
  return []
}

function recordIdFromCreatedRecord (record) {
  return String(record?.id ?? record?.attributes?.id ?? '')
}

function versionFromCreatedRecords (records) {
  const versions = records
    .map(record => Number(record?.attributes?.valid_from_version ?? record?.attributes?.version))
    .filter(Number.isFinite)
  if (versions.length === 0) return null
  return Math.max(...versions)
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
  #version
  #latestVersion

  constructor (client, name, description = '') {
    this.#client = client
    this.#name = name
    this.#description = description
    this.#records = []
    this.#recordIds = []
    this.#id = null
    this.#projectId = null
    this.#pushedCount = 0
    this.#version = null
    this.#latestVersion = null
  }

  // Build a Dataset that already exists remotely (used by pullDataset).
  static fromExisting (client, name, description, id, projectId, records, recordIds, version, latestVersion) {
    const dataset = new Dataset(client, name, description)
    dataset.#id = id
    dataset.#projectId = projectId
    dataset.#records.push(...records)
    dataset.#recordIds.push(...recordIds)
    dataset.#pushedCount = records.length
    dataset.#version = version ?? null
    dataset.#latestVersion = latestVersion ?? version ?? null
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

  version () {
    return this.#version
  }

  latestVersion () {
    return this.#latestVersion
  }

  // Dashboard URL for this dataset, or null until pushed/pulled.
  url () {
    if (this.#id === null) return null
    return `${this.#client.appBase}/llm/datasets/${this.#id}`
  }

  // Eagerly create the dataset (if needed) and push any unpushed records.
  async push () {
    const projectId = await this.#client.ensureProjectId()
    return this.ensureCreatedAndPushed(projectId)
  }

  // Create the remote dataset if needed, then push records added since the last
  // push. Idempotent and incremental. Resolves to { pushedCount, totalCount } for
  // the records attempted in this call, so callers can confirm the push landed.
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
      this.#version = response?.data?.attributes?.current_version ?? this.#version
      this.#latestVersion = response?.data?.attributes?.current_version ?? this.#latestVersion
    }

    if (this.#pushedCount >= this.#records.length) return { pushedCount: 0, totalCount: 0 }

    const pending = this.#records.slice(this.#pushedCount)
    const records = pending.map((rec) => {
      const out = { input: rec.input }
      if (rec.id !== null && rec.id !== undefined) {
        out.id = rec.id
      }
      if (rec.expectedOutput !== null && rec.expectedOutput !== undefined) {
        out.expected_output = rec.expectedOutput
      }
      if (rec.metadata && Object.keys(rec.metadata).length > 0) {
        out.metadata = rec.metadata
      }
      return out
    })

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

    // The append-records response has used both a top-level `records` array
    // and JSON:API `data` resources. Accept either so generated/custom record
    // ids are preserved for experiment row tagging.
    const created = createdRecordsFromResponse(response)
    const pushedVersion = versionFromCreatedRecords(created)
    if (pushedVersion !== null) {
      this.#version = pushedVersion
      this.#latestVersion = Math.max(Number(this.#latestVersion ?? pushedVersion), pushedVersion)
    }

    let pushedCount = 0
    for (const node of created) {
      const recordId = recordIdFromCreatedRecord(node)
      if (recordId !== '') pushedCount++
      this.#recordIds.push(recordId)
    }
    for (let i = created.length; i < pending.length; i++) this.#recordIds.push('')

    // Advance by the snapshotted pending count, not the live records length,
    // so records added while this push was in flight aren't skipped by the next push.
    this.#pushedCount += pending.length

    return { pushedCount, totalCount: pending.length }
  }
}

module.exports = { Dataset, DatasetRecord }
