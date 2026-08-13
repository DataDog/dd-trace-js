'use strict'

const { randomUUID } = require('node:crypto')

// Dataset record: { input, expectedOutput?, metadata?, id }.
// IDs are generated locally unless the caller supplies one.
class DatasetRecord {
  constructor (input, expectedOutput = null, metadata = {}, id = null) {
    if (id != null && (typeof id !== 'string' || id.length === 0)) {
      throw new Error('record id must be a non-empty string')
    }
    this.input = input
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
    this.id = id ?? randomUUID()
  }
}

function versionFromMutationResult (result) {
  return result?.version ?? null
}

function serializedRecord (record) {
  return {
    id: record.id,
    input: record.input,
    expected_output: record.expectedOutput ?? null,
    metadata: record.metadata ?? {},
  }
}

function serializedRecordUpdate (update) {
  const output = { id: update.id }
  if (Object.hasOwn(update, 'input') && update.input !== undefined) output.input = update.input
  if (Object.hasOwn(update, 'expectedOutput') && update.expectedOutput !== undefined) {
    output.expected_output = update.expectedOutput
  }
  if (Object.hasOwn(update, 'metadata') && update.metadata !== undefined) output.metadata = update.metadata
  return output
}

function valuesAreEqual (left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function updateFromInsertedRecord (recordId, record, payload) {
  const update = { id: recordId }
  if (!valuesAreEqual(record.input, payload.input)) update.input = record.input
  if (!valuesAreEqual(record.expectedOutput, payload.expected_output)) {
    update.expectedOutput = record.expectedOutput
  }
  if (!valuesAreEqual(record.metadata, payload.metadata)) update.metadata = record.metadata
  return update
}

// A local dataset model that tracks pending changes and pushes them in one batch.
class Dataset {
  #client
  #name
  #description
  #records
  #recordsById
  #newRecordsById
  #updatedRecordsById
  #deletedRecordIds
  #id
  #projectId
  #version
  #latestVersion
  #pushPromise

  constructor (client, name, description = '') {
    this.#client = client
    this.#name = name
    this.#description = description
    this.#records = []
    this.#recordsById = new Map()
    this.#newRecordsById = new Map()
    this.#updatedRecordsById = new Map()
    this.#deletedRecordIds = new Set()
    this.#id = null
    this.#projectId = null
    this.#version = null
    this.#latestVersion = null
    this.#pushPromise = Promise.resolve()
  }

  // Build a Dataset that already exists remotely (used by pullDataset).
  static fromExisting (client, name, description, id, projectId, records, version, latestVersion) {
    const dataset = new Dataset(client, name, description)
    dataset.#id = id
    dataset.#projectId = projectId
    dataset.#version = version ?? null
    dataset.#latestVersion = latestVersion ?? version ?? null
    for (const record of records) dataset.#addExistingRecord(record)
    return dataset
  }

  // Append a record. Accepts a DatasetRecord or (input, expectedOutput?, metadata?).
  addRecord (recordOrInput, expectedOutput, metadata) {
    const record = recordOrInput instanceof DatasetRecord
      ? recordOrInput
      : new DatasetRecord(recordOrInput, expectedOutput, metadata)
    this.#addRecord(record)
    return this
  }

  /**
   * Update an existing dataset record. New records are updated in place and are sent with their insert.
   * @param {number} index Dataset record index.
   * @param {{input?: unknown, expectedOutput?: unknown, metadata?: object}} fields Fields to update.
   * @returns {Dataset} This dataset for chaining.
   */
  update (index, fields) {
    if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new TypeError('record update must be an object')
    }
    const record = this.#recordAt(index)
    const fieldNames = ['input', 'expectedOutput', 'metadata']
    const providedFields = fieldNames.filter(field => Object.hasOwn(fields, field) && fields[field] !== undefined)
    if (providedFields.length === 0) {
      throw new Error('record update must include input, expectedOutput, or metadata')
    }

    for (const field of providedFields) {
      record[field] = field === 'metadata' ? (fields[field] ?? {}) : fields[field]
    }

    if (this.#newRecordsById.has(record.id)) return this

    const update = this.#updatedRecordsById.get(record.id) ?? { id: record.id }
    for (const field of providedFields) update[field] = record[field]
    this.#updatedRecordsById.set(record.id, update)
    return this
  }

  /**
   * Delete a dataset record. New records are removed locally without a backend operation.
   * @param {number} index Dataset record index.
   * @returns {Dataset} This dataset for chaining.
   */
  delete (index) {
    const record = this.#recordAt(index)
    this.#records.splice(index, 1)
    this.#recordsById.delete(record.id)

    if (this.#newRecordsById.delete(record.id)) return this

    this.#updatedRecordsById.delete(record.id)
    this.#deletedRecordIds.add(record.id)
    return this
  }

  name () {
    return this.#name
  }

  description () {
    return this.#description
  }

  records () {
    return [...this.#records]
  }

  recordIds () {
    return this.#records.map(record => record.id)
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

  // Eagerly create the dataset (if needed) and push all pending changes.
  push () {
    return this.#enqueuePush(async () => {
      const projectId = await this.#client.ensureProjectId()
      return this.#ensureCreatedAndPushed(projectId)
    })
  }

  // Called by Experiment.run() after it has resolved the project id.
  ensureCreatedAndPushed (projectId) {
    return this.#enqueuePush(() => this.#ensureCreatedAndPushed(projectId))
  }

  #enqueuePush (push) {
    const next = this.#pushPromise.then(push, push)
    this.#pushPromise = next.then(() => {}, () => {})
    return next
  }

  async #ensureCreatedAndPushed (projectId) {
    if (this.#id === null) {
      let response
      try {
        response = await this.#client.createDataset(projectId, { name: this.#name, description: this.#description })
      } catch (err) {
        throw new Error(`Failed to create dataset '${this.#name}': ${err.message}`)
      }
      this.#id = response?.id() ?? null
      if (this.#id === null) {
        throw new Error(`Failed to create dataset '${this.#name}': backend response is missing dataset id`)
      }
      this.#projectId = projectId
      this.#version = response.version() ?? this.#version
      this.#latestVersion = response.latestVersion() ?? this.#latestVersion
    }

    const pending = this.#pendingBatch()
    if (pending.totalCount === 0) return { pushedCount: 0, totalCount: 0 }

    let result
    try {
      result = await this.#client.batchUpdateDatasetRecords(projectId, this.#id, pending.attributes)
    } catch (err) {
      throw new Error(`Failed to push changes to dataset '${this.#name}': ${err.message}`)
    }

    this.#updateVersionFromMutationResult(result)
    this.#clearCommittedChanges(pending)
    return { pushedCount: pending.totalCount, totalCount: pending.totalCount }
  }

  #pendingBatch () {
    const insertRecords = []
    const insertPayloads = new Map()
    for (const [recordId, record] of this.#newRecordsById) {
      const payload = serializedRecord(record)
      insertRecords.push(payload)
      insertPayloads.set(recordId, payload)
    }

    const updateRecords = []
    const updatePayloads = new Map()
    for (const [recordId, update] of this.#updatedRecordsById) {
      const payload = serializedRecordUpdate(update)
      updateRecords.push(payload)
      updatePayloads.set(recordId, payload)
    }

    const deleteRecordIds = [...this.#deletedRecordIds]
    return {
      attributes: {
        insert_records: insertRecords,
        update_records: updateRecords,
        delete_records: deleteRecordIds,
        deduplicate: true,
        create_new_version: true,
      },
      deleteRecordIds,
      insertPayloads,
      updatePayloads,
      totalCount: new Set([
        ...insertPayloads.keys(),
        ...updatePayloads.keys(),
        ...deleteRecordIds,
      ]).size,
    }
  }

  #clearCommittedChanges (pending) {
    for (const [recordId, payload] of pending.insertPayloads) {
      const current = this.#newRecordsById.get(recordId)
      if (!current) {
        this.#deletedRecordIds.add(recordId)
        continue
      }
      if (valuesAreEqual(serializedRecord(current), payload)) {
        this.#newRecordsById.delete(recordId)
        continue
      }

      this.#newRecordsById.delete(recordId)
      const update = this.#updatedRecordsById.get(recordId) ??
        updateFromInsertedRecord(recordId, current, payload)
      this.#updatedRecordsById.set(recordId, update)
    }

    for (const [recordId, payload] of pending.updatePayloads) {
      const current = this.#updatedRecordsById.get(recordId)
      if (current && valuesAreEqual(serializedRecordUpdate(current), payload)) {
        this.#updatedRecordsById.delete(recordId)
      }
    }

    for (const recordId of pending.deleteRecordIds) {
      if (!this.#recordsById.has(recordId)) this.#deletedRecordIds.delete(recordId)
    }
  }

  #updateVersionFromMutationResult (result) {
    const pushedVersion = versionFromMutationResult(result)
    if (pushedVersion !== null) {
      this.#version = pushedVersion
      this.#latestVersion = pushedVersion
      return
    }

    const latestVersion = Number(this.#latestVersion)
    if (Number.isFinite(latestVersion)) {
      this.#version = latestVersion + 1
      this.#latestVersion = this.#version
    } else {
      this.#version = null
    }
  }

  #addRecord (record) {
    if (this.#recordsById.has(record.id)) throw new Error(`Duplicate record id '${record.id}'`)
    this.#records.push(record)
    this.#recordsById.set(record.id, record)
    this.#deletedRecordIds.delete(record.id)
    this.#newRecordsById.set(record.id, record)
  }

  #addExistingRecord (record) {
    if (record.id === null || record.id === undefined || record.id === '') {
      throw new Error('Dataset records pulled from the backend must have an id')
    }
    if (!(record instanceof DatasetRecord)) {
      record = new DatasetRecord(
        record.input,
        record.expectedOutput,
        record.metadata,
        record.id
      )
    }
    if (this.#recordsById.has(record.id)) throw new Error(`Duplicate record id '${record.id}'`)
    this.#records.push(record)
    this.#recordsById.set(record.id, record)
  }

  #recordAt (index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#records.length) {
      throw new RangeError(`Dataset record index ${index} is out of range`)
    }
    return this.#records[index]
  }
}

module.exports = { Dataset, DatasetRecord }
