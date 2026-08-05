'use strict'

function validateTagsList (tags) {
  if (tags == null) return []
  if (!Array.isArray(tags)) throw new TypeError('Tags must be an array of strings')
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new TypeError('Each tag must be a string')
    if (!tag.includes(':')) {
      throw new Error(`Tag '${tag}' is malformed. Tags must be in 'key:value' format (e.g., 'env:prod').`)
    }
  }
  return [...tags]
}

function tagOperationsAreEmpty (operations) {
  return operations == null || (
    !Object.hasOwn(operations, 'replace') &&
    !Object.hasOwn(operations, 'add') &&
    !Object.hasOwn(operations, 'remove')
  )
}

// Dataset record: { input, expectedOutput?, metadata?, tags?, id? }.
// `id` may be user-provided before push or filled from the backend-created record.
class DatasetRecord {
  #version

  constructor (input, expectedOutput = null, metadata = {}, id = null, version = null, tags = []) {
    this.input = input
    this.expectedOutput = expectedOutput ?? null
    this.metadata = metadata ?? {}
    this.tags = validateTagsList(tags)
    this.id = id ?? null
    this.#version = version ?? null
  }

  /**
   * @returns {number | string | null} The dataset version where this record became valid.
   */
  version () {
    return this.#version
  }

  _setVersion (version) {
    this.#version = version ?? null
    return this
  }
}

function recordIdFromCreatedRecord (record) {
  return String(record?.id ?? '')
}

function recordVersionFromCreatedRecord (record) {
  return typeof record?.version === 'function' ? record.version() : null
}

function versionFromCreatedRecords (records) {
  const versions = records
    .map(recordVersionFromCreatedRecord)
    .filter(version => version != null)
    .map(Number)
    .filter(Number.isFinite)
  if (versions.length === 0) return null
  return Math.max(...versions)
}

function serializedRecord (rec) {
  const out = { input: rec.input }
  if (rec.id != null) {
    out.id = rec.id
  }
  if (rec.expectedOutput !== null && rec.expectedOutput !== undefined) {
    out.expected_output = rec.expectedOutput
  }
  if (rec.metadata && Object.keys(rec.metadata).length > 0) {
    out.metadata = rec.metadata
  }
  if (rec.tags.length > 0) {
    out.tags = rec.tags
  }
  return out
}

function serializedTagOperations (operations) {
  const out = {}
  if (Object.hasOwn(operations, 'add')) out.add = operations.add
  if (Object.hasOwn(operations, 'remove')) out.remove = operations.remove
  if (Object.hasOwn(operations, 'replace')) out.set = operations.replace
  return out
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
  #filterTags
  #pendingTagOperations

  constructor (client, name, description = '', filterTags = []) {
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
    this.#filterTags = validateTagsList(filterTags)
    this.#pendingTagOperations = new Map()
  }

  // Build a Dataset that already exists remotely (used by pullDataset).
  static fromExisting (
    client, name, description, id, projectId, records, recordIds, version, latestVersion, filterTags
  ) {
    const dataset = new Dataset(client, name, description, filterTags)
    dataset.#id = id
    dataset.#projectId = projectId
    dataset.#records.push(...records)
    dataset.#recordIds.push(...recordIds)
    dataset.#pushedCount = records.length
    dataset.#version = version ?? null
    dataset.#latestVersion = latestVersion ?? version ?? null
    return dataset
  }

  // Append a record. Accepts a DatasetRecord or (input, expectedOutput?, metadata?, tags?).
  addRecord (recordOrInput, expectedOutput, metadata, tags) {
    const record = recordOrInput instanceof DatasetRecord
      ? recordOrInput
      : new DatasetRecord(recordOrInput, expectedOutput, metadata, null, null, tags)
    this.#records.push(record)
    return this
  }

  /**
   * Add tags to a dataset record. Tags merge with existing tags and are pushed with the next push().
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in `key:value` format.
   * @returns {Dataset} This dataset for chaining.
   */
  addTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    const next = new Set(record.tags)
    for (const tag of validated) next.add(tag)
    record.tags = [...next].sort()
    this.#queueTagOperation(index, record, 'add', validated)
    return this
  }

  /**
   * Remove tags from a dataset record. The removal is pushed with the next push().
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in `key:value` format.
   * @returns {Dataset} This dataset for chaining.
   */
  removeTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    const next = new Set(record.tags)
    for (const tag of validated) next.delete(tag)
    record.tags = [...next].sort()
    this.#queueTagOperation(index, record, 'remove', validated)
    return this
  }

  /**
   * Replace all tags on a dataset record. The replacement is pushed with the next push().
   * @param {number} index Dataset record index.
   * @param {string[]} tags Tags in `key:value` format.
   * @returns {Dataset} This dataset for chaining.
   */
  replaceTags (index, tags) {
    const validated = validateTagsList(tags)
    const record = this.#recordAt(index)
    record.tags = validated
    this.#queueTagOperation(index, record, 'replace', validated)
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

  filterTags () {
    return [...this.#filterTags]
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

    const result = await this.#pushPendingRecords(projectId)
    await this.#pushPendingTagOperations(projectId)
    return result
  }

  async #pushPendingRecords (projectId) {
    if (this.#pushedCount >= this.#records.length) return { pushedCount: 0, totalCount: 0 }

    const pending = this.#records.slice(this.#pushedCount)
    const records = pending.map(serializedRecord)

    let response
    try {
      response = await this.#client.appendDatasetRecords(projectId, this.#id, records)
    } catch (err) {
      throw new Error(`Failed to push records to dataset '${this.#name}': ${err.message}`)
    }

    this.#updateVersionFromRecords(response)

    let pushedCount = 0
    for (const [index, node] of response.entries()) {
      const recordId = recordIdFromCreatedRecord(node)
      if (recordId !== '') {
        pushedCount++
        pending[index].id = recordId
      }
      const recordVersion = recordVersionFromCreatedRecord(node)
      if (recordVersion !== null) pending[index]._setVersion(recordVersion)
      this.#recordIds.push(recordId)
    }
    for (let i = response.length; i < pending.length; i++) this.#recordIds.push('')

    // Advance by the snapshotted pending count, not the live records length,
    // so records added while this push was in flight aren't skipped by the next push.
    this.#pushedCount += pending.length

    return { pushedCount, totalCount: pending.length }
  }

  async #pushPendingTagOperations (projectId) {
    if (this.#pendingTagOperations.size === 0) return

    const updateRecords = []
    for (const [recordId, operations] of this.#pendingTagOperations) {
      updateRecords.push({ id: recordId, tag_operations: serializedTagOperations(operations) })
    }

    let response
    try {
      response = await this.#client.batchUpdateDatasetRecords(projectId, this.#id, {
        insert_records: [],
        update_records: updateRecords,
        delete_records: [],
        deduplicate: true,
        create_new_version: true,
      })
    } catch (err) {
      throw new Error(`Failed to update tags for dataset '${this.#name}': ${err.message}`)
    }

    this.#updateVersionFromRecords(response)
    this.#updateRecordVersions(response)
    this.#pendingTagOperations.clear()
  }

  #updateVersionFromRecords (records) {
    const pushedVersion = versionFromCreatedRecords(records)
    if (pushedVersion === null) {
      // The dataset contents changed, but the backend did not report the new
      // version. Avoid pinning later experiments to the pre-append create version.
      this.#version = null
    } else {
      this.#version = pushedVersion
      this.#latestVersion = Math.max(Number(this.#latestVersion ?? pushedVersion), pushedVersion)
    }
  }

  #updateRecordVersions (records) {
    const versionsById = new Map()
    for (const record of records) {
      const recordId = recordIdFromCreatedRecord(record)
      const recordVersion = recordVersionFromCreatedRecord(record)
      if (recordId !== '' && recordVersion !== null) versionsById.set(recordId, recordVersion)
    }

    for (const record of this.#records) {
      const recordVersion = versionsById.get(record.id)
      if (recordVersion !== undefined) record._setVersion(recordVersion)
    }
  }

  #recordAt (index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.#records.length) {
      throw new RangeError(`Dataset record index ${index} is out of range`)
    }
    return this.#records[index]
  }

  #queueTagOperation (index, record, operation, tags) {
    if (index >= this.#pushedCount) return
    if (record.id === null || record.id === '') throw new Error('record id is required to update tags')
    this.#accumulateTagOperations(record.id, operation, tags)
  }

  #accumulateTagOperations (recordId, operation, tags) {
    let operations = this.#pendingTagOperations.get(recordId) ?? {}

    if (operation === 'replace') {
      operations = { replace: [...tags] }
    } else if (operation === 'add') {
      operations = this.#mergeAddOperation(operations, tags)
    } else if (operation === 'remove') {
      operations = this.#mergeRemoveOperation(operations, tags)
    }

    if (tagOperationsAreEmpty(operations)) this.#pendingTagOperations.delete(recordId)
    else this.#pendingTagOperations.set(recordId, operations)
  }

  #mergeAddOperation (operations, tags) {
    if (Object.hasOwn(operations, 'replace')) {
      const replaced = new Set(operations.replace)
      for (const tag of tags) replaced.add(tag)
      return { replace: [...replaced].sort() }
    }

    const add = new Set(operations.add ?? [])
    const remove = new Set(operations.remove ?? [])
    for (const tag of tags) {
      if (remove.has(tag)) remove.delete(tag)
      else add.add(tag)
    }
    return this.#tagOperationSets(add, remove)
  }

  #mergeRemoveOperation (operations, tags) {
    if (Object.hasOwn(operations, 'replace')) {
      const replaced = new Set(operations.replace)
      for (const tag of tags) replaced.delete(tag)
      return { replace: [...replaced].sort() }
    }

    const add = new Set(operations.add ?? [])
    const remove = new Set(operations.remove ?? [])
    for (const tag of tags) {
      if (add.has(tag)) add.delete(tag)
      else remove.add(tag)
    }
    return this.#tagOperationSets(add, remove)
  }

  #tagOperationSets (add, remove) {
    const operations = {}
    if (add.size > 0) operations.add = [...add].sort()
    if (remove.size > 0) operations.remove = [...remove].sort()
    return operations
  }
}

module.exports = { Dataset, DatasetRecord, validateTagsList }
