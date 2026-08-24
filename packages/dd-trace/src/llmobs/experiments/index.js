'use strict'

const log = require('../../log')
const { ExperimentsClient } = require('./client')
const { Dataset, DatasetRecord } = require('./dataset')
const { Experiment, ExternalExperiment } = require('./experiment')
const { validateTagsList } = require('./util')
const NoopExperiments = require('./noop')

const DEFAULT_PROJECT_NAME = 'default-project'

// Poll `attempt` with exponential backoff until it returns true or the time
// budget is spent. Used for eventually-consistent reads (pullDataset).
async function retryWithBackoff (attempt, { maxTotalMs = 30_000, baseDelayMs = 250, maxDelayMs = 8000 } = {}) {
  const start = Date.now()
  let delay = baseDelayMs
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await attempt()) return true
    const remaining = maxTotalMs - (Date.now() - start)
    if (remaining <= 0) return false
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, maxDelayMs, remaining)))
    delay *= 2
  }
}

// Entry point exposed as `tracer.llmobs.experiments`. Builds datasets and runs
// experiments against the LLM Obs backend using the tracer's own config.
class Experiments {
  #client
  #config
  #llmobs
  #projectName

  constructor (config, llmobs) {
    this.#config = config
    this.#llmobs = config.llmobs?.mlApp || config.service ? llmobs : undefined
    this.#projectName = config.llmobs?.projectName || DEFAULT_PROJECT_NAME
    this.#client = this.#clientForProject(this.#projectName)
  }

  /**
   * @param {string} projectName
   * @returns {ExperimentsClient}
   */
  #clientForProject (projectName) {
    return new ExperimentsClient({
      apiKey: this.#config.DD_API_KEY,
      appKey: this.#config.DD_APP_KEY,
      site: this.#config.site,
      projectName,
    })
  }

  /**
   * @param {string | undefined} projectName
   * @returns {ExperimentsClient}
   */
  #clientForOperation (projectName) {
    if (projectName !== undefined && projectName !== this.#projectName) {
      return this.#clientForProject(projectName)
    }
    if (this.#client === undefined) this.#client = this.#clientForProject(projectName)
    return this.#client
  }

  // Create a local dataset buffer. Pushed remotely on first experiment run.
  createDataset (name, descriptionOrOptions = '') {
    const options = typeof descriptionOrOptions === 'string'
      ? { description: descriptionOrOptions }
      : (descriptionOrOptions ?? {})
    const client = this.#clientForOperation(options.projectName)
    const dataset = new Dataset(client, name, options.description ?? '')
    const recordIds = new Set()
    if ((options.records) != null) {
      for (const record of options.records) {
        if (record.id !== undefined && (typeof record.id !== 'string' || record.id.length === 0)) {
          throw new Error('record id must be a non-empty string')
        }
        if (record.id !== undefined) {
          if (recordIds.has(record.id)) throw new Error(`Duplicate record id '${record.id}'`)
          recordIds.add(record.id)
        }
        dataset.addRecord(
          new DatasetRecord(record.inputData, record.expectedOutput, record.metadata, record.id, record.tags)
        )
      }
    }
    return dataset
  }

  // Pull an existing dataset by name (with its records). Polls with exponential
  // backoff to absorb read-after-write lag; pass `expectedRecordCount` to also
  // wait until that many records are readable. Pass `tags` to filter records by
  // dataset record tags.
  async pullDataset (name, options = {}) {
    const { expectedRecordCount, maxWaitMs = 30_000, projectName, tags, version } = options
    const filterTags = validateTagsList(tags)
    const client = this.#clientForOperation(projectName)
    const resolvedProjectName = projectName ?? this.#projectName
    const projectId = await client.ensureProjectId()

    let pulledDataset = null
    let records = []
    const datasetVersion = version ?? null
    let latestVersion = null
    let lastError = ''

    const succeeded = await retryWithBackoff(async () => {
      try {
        if (pulledDataset === null) {
          const datasets = await client.listDatasets(projectId, { name })
          for (const dataset of datasets) {
            if (dataset.name() === name) {
              pulledDataset = dataset
              latestVersion = dataset.latestVersion()
              break
            }
          }
          if (pulledDataset === null) return false
        }

        const recs = []
        let cursor = ''
        // Follow the meta.after / page[cursor] pagination until the last page.
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const page = await client.listDatasetRecords(projectId, pulledDataset.id(), {
            cursor,
            tags: filterTags,
            version: datasetVersion,
          })
          for (const record of page.records) recs.push(record)
          cursor = page.after
          if (!cursor) break
        }
        records = recs
        lastError = ''

        return expectedRecordCount == null || recs.length >= expectedRecordCount
      } catch (err) {
        lastError = err.message
        return false
      }
    }, { maxTotalMs: maxWaitMs })

    if (pulledDataset === null && lastError) {
      throw new Error(`Failed to list datasets in project '${resolvedProjectName}': ${lastError}`)
    }
    if (pulledDataset === null) {
      throw new Error(`Dataset '${name}' not found in project '${resolvedProjectName}' (after ${maxWaitMs}ms)`)
    }
    if (!succeeded && lastError) {
      throw new Error(`Failed to fetch records for dataset '${name}' in project '${resolvedProjectName}': ${lastError}`)
    }
    if (!succeeded && expectedRecordCount != null) {
      throw new Error(
        `Dataset '${name}' has ${records.length} record(s) after ${maxWaitMs}ms, expected ${expectedRecordCount} ` +
        '— backend may not have finished ingesting the push'
      )
    }

    for (const record of records) {
      if (record.id === null || record.id === undefined || record.id === '') {
        throw new Error(`Failed to pull dataset '${name}': backend returned a record without an id`)
      }
    }

    return Dataset.fromExisting(
      client,
      name,
      pulledDataset.description(),
      pulledDataset.id(),
      projectId,
      records,
      datasetVersion,
      latestVersion,
      filterTags
    )
  }

  // Build an experiment with a dataset, task, evaluators, and optional project/config/tags.
  experiment (options) {
    const datasetProjectName = options?.dataset?.projectName?.()
    if (options?.projectName !== undefined &&
        datasetProjectName !== undefined &&
        options.projectName !== datasetProjectName) {
      throw new Error(
        `Experiment project '${options.projectName}' does not match dataset project '${datasetProjectName}'`
      )
    }
    const projectName = options?.projectName ?? datasetProjectName
    const client = this.#clientForOperation(projectName)
    const usesDatasetOverride = datasetProjectName !== undefined && datasetProjectName !== this.#projectName
    const resolvedProjectName = projectName ?? this.#config.llmobs?.projectName
    const experimentOptions = options?.projectName === undefined &&
      (usesDatasetOverride || this.#config.llmobs?.projectName !== undefined) &&
      resolvedProjectName !== undefined
      ? { ...options, projectName: resolvedProjectName }
      : options
    return new Experiment(client, experimentOptions, this.#llmobs)
  }

  /**
   * Start an externally-driven experiment for eval frameworks that already own
   * task execution. Call submitSpan() once per completed row, then
   * submitEvaluationMetrics() with the generated span id.
   *
   * @param {object} options
   * @returns {Promise<ExternalExperiment>}
   */
  startExperiment (options) {
    const client = this.#clientForOperation(options?.projectName)
    const experimentOptions = options?.projectName === undefined && this.#config.llmobs?.projectName !== undefined
      ? { ...options, projectName: this.#config.llmobs.projectName }
      : options
    return new Experiment(client, { ...experimentOptions, external: true }).start()
      .then(experiment => new ExternalExperiment(experiment))
  }
}

// Factory used by the LLMObs SDK: returns a real Experiments instance when
// enabled and credentialed, otherwise a no-op that explains what's missing.
function createExperiments (config, llmobs) {
  if (!config.llmobs?.DD_LLMOBS_ENABLED) {
    return new NoopExperiments('LLM Observability is not enabled')
  }
  if (!(config.DD_API_KEY) || !config.DD_APP_KEY) {
    log.warn('LLMObs experiments: missing api and/or app keys, set DD_API_KEY and DD_APP_KEY')
    return new NoopExperiments('DD_API_KEY and DD_APP_KEY are required for experiments')
  }
  return new Experiments(config, llmobs)
}

module.exports = { Experiments, createExperiments }
