'use strict'

const { randomUUID } = require('node:crypto')
const createRfdc = require('../../../../../vendor/dist/rfdc')
const snapshotPayload = createRfdc({ proto: false, circles: false })

/** @typedef {{add?: string[], remove?: string[], replace?: string[]}} TagOperations */
/**
 * @typedef {object} DatasetRecordNew
 * @property {string} [id]
 * @property {unknown} inputData
 * @property {unknown} [expectedOutput]
 * @property {Record<string, unknown>} [metadata]
 * @property {string[]} [tags]
 */
/**
 * @typedef {object} PendingBatch
 * @property {object} attributes
 * @property {string[]} deleteRecordIds
 * @property {Map<string, object>} insertPayloads
 * @property {Map<string, object>} updatePayloads
 * @property {number} totalCount
 * @property {Map<string, TagOperations>} [inFlightTagOperations]
 */

const { tagOperationsAreEmpty, validateTagsList } = require('./util')

// Dataset record: { input, expectedOutput?, metadata?, id, tags? }.
// IDs are generated locally unless the caller supplies one.
class DatasetRecord {
  constructor (input, expectedOutput = null, metadata = {}, id = null, tags = []) {
    if (id != null && (typeof id !== 'string' || id.length === 0)) {
      throw new Error('record id must be a non-empty string')
    }
    this.input = input
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
    this.tags = validateTagsList(tags)
    this.id = id ?? randomUUID()
  }
}

function versionFromMutationResult (result) {
  return result?.version ?? null
}

function serializedRecord (record) {
  const output = {
    id: record.id,
    input: record.input,
    expected_output: record.expectedOutput ?? null,
    metadata: record.metadata ?? {},
  }
  if (record.tags.length > 0) output.tags = record.tags
  return output
}

function serializedRecordUpdate (update) {
  const output = { id: update.id }
  if (Object.hasOwn(update, 'input') && update.input !== undefined) output.input = update.input
  if (Object.hasOwn(update, 'expectedOutput') && update.expectedOutput !== undefined) {
    output.expected_output = update.expectedOutput
  }
  if (Object.hasOwn(update, 'metadata') && update.metadata !== undefined) output.metadata = update.metadata
  if (Object.hasOwn(update, 'tagOperations')) {
    output.tag_operations = serializedTagOperations(update.tagOperations)
  }
  return output
}

function serializedTagOperations (operations) {
  const output = {}
  if (Object.hasOwn(operations, 'add')) output.add = operations.add
  if (Object.hasOwn(operations, 'remove')) output.remove = operations.remove
  if (Object.hasOwn(operations, 'replace')) output.set = operations.replace
  return output
}

/**
 * @param {TagOperations} operations
 * @returns {TagOperations}
 */
function copyTagOperations (operations) {
  return Object.fromEntries(Object.entries(operations).map(([key, tags]) => [key, [...tags]]))
}

function mergeTagOperations (operations, operation, tags) {
  if (operation === 'replace') return { replace: [...tags] }
  if (Object.hasOwn(operations, 'replace')) {
    const replaced = new Set(operations.replace)
    for (const tag of tags) {
      if (operation === 'add') replaced.add(tag)
      else replaced.delete(tag)
    }
    return { replace: [...replaced].sort() }
  }

  const add = new Set(operations.add)
  const remove = new Set(operations.remove)
  for (const tag of tags) {
    if (operation === 'add') {
      if (remove.has(tag)) remove.delete(tag)
      else add.add(tag)
    } else if (add.has(tag)) {
      add.delete(tag)
    } else {
      remove.add(tag)
    }
  }
  const merged = {}
  if (add.size > 0) merged.add = [...add].sort()
  if (remove.size > 0) merged.remove = [...remove].sort()
  return merged
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
  if (!valuesAreEqual(record.tags, payload.tags ?? [])) {
    update.tagOperations = { replace: [...record.tags] }
  }
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
  #pendingTagOperations
  #id
  #projectId
  #version
  #latestVersion
  #pushPromise
  #filterTags

  constructor (client, name, description = '', filterTags = []) {
    this.#client = client
    this.#name = name
    this.#description = description
    this.#filterTags = validateTagsList(filterTags)
    this.#records = []
    this.#recordsById = new Map()
    this.#newRecordsById = new Map()
    this.#updatedRecordsById = new Map()
    this.#deletedRecordIds = new Set()
    this.#pendingTagOperations = new Map()
    this.#id = null
    this.#projectId = null
    this.#version = null
    this.#latestVersion = null
    this.#pushPromise = Promise.resolve()
  }

  // Build a Dataset that already exists remotely (used by pullDataset).
  static fromExisting (client, name, description, id, projectId, records, version, latestVersion, filterTags) {
    const dataset = new Dataset(client, name, description, filterTags)
    dataset.#id = id
    dataset.#projectId = projectId
    dataset.#version = version ?? null
    dataset.#latestVersion = latestVersion ?? version ?? null
    for (const record of records) dataset.#addExistingRecord(record)
    return dataset
  }

  // Append a record. Accepts a DatasetRecord or (input, expectedOutput?, metadata?).
  addRecord (recordOrInput, expectedOutput, metadata, tags) {
    const record = recordOrInput instanceof DatasetRecord
      ? recordOrInput
      : new DatasetRecord(recordOrInput, expectedOutput, metadata, null, tags)
    this.#addRecord(record)
    return this
  }

  /**
   * Add multiple records to a dataset.
   * @param {DatasetRecordNew[]} records
   * @returns {Dataset} This dataset for chaining.
   */
  addRecords (records) {
    const newRecords = []
    const recordIds = new Set(this.#recordsById.keys())

    // Construct and validate the entire batch before mutating the dataset.
    for (const record of records) {
      if (record.id !== undefined && (typeof record.id !== 'string' || record.id.length === 0)) {
        throw new Error('record id must be a non-empty string')
      }
      const newRecord = new DatasetRecord(
        record.inputData,
        record.expectedOutput,
        record.metadata,
        record.id,
        record.tags
      )
      if (recordIds.has(newRecord.id)) throw new Error(`Duplicate record id '${newRecord.id}'`)
      recordIds.add(newRecord.id)
      newRecords.push(newRecord)
    }

    for (const record of newRecords) this.#addRecord(record)
    return this
  }

  /**
   * Add tags to a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {Dataset} This dataset for chaining.
   */
  addTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    const next = new Set(record.tags)
    const added = []
    for (const tag of validated) {
      if (next.has(tag)) continue
      next.add(tag)
      added.push(tag)
    }
    record.tags = [...next].sort()
    this.#queueTagOperation(record.id, 'add', added)
    return this
  }

  /**
   * Remove tags from a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {Dataset} This dataset for chaining.
   */
  removeTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    const next = new Set(record.tags)
    const removed = []
    for (const tag of validated) {
      if (!next.has(tag)) continue
      next.delete(tag)
      removed.push(tag)
    }
    record.tags = [...next].sort()
    this.#queueTagOperation(record.id, 'remove', removed)
    return this
  }

  /**
   * Replace all tags on a dataset record.
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in key:value format.
   * @returns {Dataset} This dataset for chaining.
   */
  replaceTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    record.tags = validated
    this.#queueTagOperation(record.id, 'replace', validated)
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
    if (this.#pendingTagOperations.has(record.id)) {
      update.tagOperations = this.#pendingTagOperations.get(record.id)
    }
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

    if (this.#newRecordsById.delete(record.id)) {
      this.#pendingTagOperations.delete(record.id)
      return this
    }

    this.#updatedRecordsById.delete(record.id)
    this.#pendingTagOperations.delete(record.id)
    this.#deletedRecordIds.add(record.id)
    return this
  }

  /**
   * Queue a tag operation for the next dataset push.
   * @param {string} recordId Dataset record id.
   * @param {'add' | 'remove' | 'replace'} operation Tag operation to queue.
   * @param {string[]} tags Tags in key:value format.
   * @returns {void}
   */
  #queueTagOperation (recordId, operation, tags) {
    if (operation !== 'replace' && tags.length === 0) return
    const operations = mergeTagOperations(this.#pendingTagOperations.get(recordId) ?? {}, operation, tags)
    if (tagOperationsAreEmpty(operations)) {
      this.#pendingTagOperations.delete(recordId)
      const update = this.#updatedRecordsById.get(recordId)
      if (update) {
        const hasRecordUpdate = Object.hasOwn(update, 'input') ||
          Object.hasOwn(update, 'expectedOutput') ||
          Object.hasOwn(update, 'metadata')
        delete update.tagOperations
        if (!hasRecordUpdate) this.#updatedRecordsById.delete(recordId)
      }
      return
    }
    this.#pendingTagOperations.set(recordId, operations)
    if (!this.#newRecordsById.has(recordId)) {
      const update = this.#updatedRecordsById.get(recordId) ?? { id: recordId }
      update.tagOperations = operations
      this.#updatedRecordsById.set(recordId, update)
    }
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

  projectName () {
    return this.#client.projectName
  }

  version () {
    return this.#version
  }

  latestVersion () {
    return this.#latestVersion
  }

  /**
   * Return the tags used to filter this dataset.
   * @returns {string[]} Dataset record filter tags.
   */
  filterTags () {
    return [...this.#filterTags]
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

    this.#detachCommittedTagOperations(pending)

    let result
    try {
      result = await this.#client.batchUpdateDatasetRecords(projectId, this.#id, pending.attributes)
    } catch (err) {
      this.#restoreFailedTagOperations(pending)
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
      const payload = snapshotPayload(serializedRecord(record))
      insertRecords.push(payload)
      insertPayloads.set(recordId, payload)
    }

    const updateRecords = []
    const updatePayloads = new Map()
    for (const [recordId, update] of this.#updatedRecordsById) {
      const tagOperations = this.#pendingTagOperations.get(recordId)
      if (tagOperations) update.tagOperations = tagOperations
      else delete update.tagOperations
      const payload = snapshotPayload(serializedRecordUpdate(update))
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

  /**
   * Detach tag changes sent by this batch so edits made while the request is in flight
   * are queued relative to the response that this batch will commit.
   * @param {PendingBatch} pending
   * @returns {void}
   */
  #detachCommittedTagOperations (pending) {
    pending.inFlightTagOperations = new Map()
    for (const [recordId] of pending.insertPayloads) {
      const operations = this.#pendingTagOperations.get(recordId)
      if (!operations) continue
      pending.inFlightTagOperations.set(recordId, copyTagOperations(operations))
      this.#pendingTagOperations.delete(recordId)
    }
    for (const [recordId, payload] of pending.updatePayloads) {
      const operations = this.#pendingTagOperations.get(recordId)
      if (!operations || !Object.hasOwn(payload, 'tag_operations')) continue

      pending.inFlightTagOperations.set(recordId, copyTagOperations(operations))
      this.#pendingTagOperations.delete(recordId)
      const update = this.#updatedRecordsById.get(recordId)
      if (update) delete update.tagOperations
    }
  }

  /**
   * Restore tag changes when a batch request fails, including edits made while it was in flight.
   * @param {PendingBatch} pending
   * @returns {void}
   */
  #restoreFailedTagOperations (pending) {
    if (!pending.inFlightTagOperations) return
    for (const [recordId, operations] of pending.inFlightTagOperations) {
      const record = this.#recordsById.get(recordId)
      if (!record || this.#newRecordsById.has(recordId) || this.#deletedRecordIds.has(recordId)) continue

      const update = this.#updatedRecordsById.get(recordId) ?? { id: recordId }
      const queuedOperations = this.#pendingTagOperations.get(recordId)
      const restoredOperations = queuedOperations
        ? { replace: [...record.tags] }
        : copyTagOperations(operations)
      this.#pendingTagOperations.set(recordId, restoredOperations)
      update.tagOperations = restoredOperations
      this.#updatedRecordsById.set(recordId, update)
    }
  }

  /**
   * Clear the changes represented by a completed batch while retaining concurrent local edits.
   * @param {PendingBatch} pending
   * @returns {void}
   */
  #clearCommittedChanges (pending) {
    for (const [recordId, payload] of pending.insertPayloads) {
      const current = this.#newRecordsById.get(recordId)
      if (!current) {
        this.#deletedRecordIds.add(recordId)
        continue
      }
      if (valuesAreEqual(serializedRecord(current), payload)) {
        this.#newRecordsById.delete(recordId)
        this.#pendingTagOperations.delete(recordId)
        continue
      }

      this.#newRecordsById.delete(recordId)
      const update = this.#updatedRecordsById.get(recordId) ??
        updateFromInsertedRecord(recordId, current, payload)
      const queuedOperations = this.#pendingTagOperations.get(recordId)
      if (queuedOperations) update.tagOperations = queuedOperations
      if (update.tagOperations) {
        this.#pendingTagOperations.set(recordId, copyTagOperations(update.tagOperations))
      }
      this.#updatedRecordsById.set(recordId, update)
    }

    for (const [recordId, payload] of pending.updatePayloads) {
      const current = this.#updatedRecordsById.get(recordId)
      const queuedOperations = this.#pendingTagOperations.get(recordId)
      if (!current || queuedOperations) continue

      const comparison = { ...current }
      const committedOperations = pending.inFlightTagOperations?.get(recordId)
      if (committedOperations) comparison.tagOperations = committedOperations
      if (valuesAreEqual(serializedRecordUpdate(comparison), payload)) {
        this.#updatedRecordsById.delete(recordId)
        this.#pendingTagOperations.delete(recordId)
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
        record.id,
        record.tags
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
