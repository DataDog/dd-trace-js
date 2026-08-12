'use strict'

const log = require('../../log')
const { ExperimentsClient } = require('./client')
const { Dataset, DatasetRecord } = require('./dataset')
const { Experiment, ExternalExperiment } = require('./experiment')
const NoopExperiments = require('./noop')

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
    this.#llmobs = llmobs
    this.#projectName = config.llmobs?.mlApp || config.service
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

  // Create a local dataset buffer. Pushed remotely on first experiment run.
  createDataset (name, descriptionOrOptions = '') {
    const options = typeof descriptionOrOptions === 'string'
      ? { description: descriptionOrOptions }
      : (descriptionOrOptions ?? {})
    const dataset = new Dataset(this.#client, name, options.description ?? '')
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
        dataset.addRecord(new DatasetRecord(record.inputData, record.expectedOutput, record.metadata, record.id))
      }
    }
    return dataset
  }

  // Pull an existing dataset by name (with its records). Polls with exponential
  // backoff to absorb read-after-write lag; pass `expectedRecordCount` to also
  // wait until that many records are readable.
  async pullDataset (name, options = {}) {
    const { expectedRecordCount, maxWaitMs = 30_000, version } = options
    const projectId = await this.#client.ensureProjectId()

    let pulledDataset = null
    let records = []
    let recordIds = []
    let datasetVersion = version ?? null
    let latestVersion = null
    let lastError = ''

    const succeeded = await retryWithBackoff(async () => {
      try {
        if (pulledDataset === null) {
          const datasets = await this.#client.listDatasets(projectId, { name })
          for (const dataset of datasets) {
            if (dataset.name() === name) {
              pulledDataset = dataset
              latestVersion = dataset.latestVersion()
              datasetVersion = version ?? latestVersion
              break
            }
          }
          if (pulledDataset === null) return false
        }

        const recs = []
        const ids = []
        let cursor = ''
        // Follow the meta.after / page[cursor] pagination until the last page.
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const page = await this.#client.listDatasetRecords(projectId, pulledDataset.id(), {
            cursor,
            version: datasetVersion,
          })
          for (const record of page.records) {
            recs.push(record)
            ids.push(String(record.id ?? ''))
          }
          cursor = page.after
          if (!cursor) break
        }
        records = recs
        recordIds = ids
        lastError = ''

        return expectedRecordCount == null || recs.length >= expectedRecordCount
      } catch (err) {
        lastError = err.message
        return false
      }
    }, { maxTotalMs: maxWaitMs })

    if (pulledDataset === null && lastError) {
      throw new Error(`Failed to list datasets in project '${this.#projectName}': ${lastError}`)
    }
    if (pulledDataset === null) {
      throw new Error(`Dataset '${name}' not found in project '${this.#projectName}' (after ${maxWaitMs}ms)`)
    }
    if (!succeeded && lastError) {
      throw new Error(`Failed to fetch records for dataset '${name}' in project '${this.#projectName}': ${lastError}`)
    }
    if (!succeeded && expectedRecordCount != null) {
      throw new Error(
        `Dataset '${name}' has ${records.length} record(s) after ${maxWaitMs}ms, expected ${expectedRecordCount} ` +
        '— backend may not have finished ingesting the push'
      )
    }

    return Dataset.fromExisting(
      this.#client,
      name,
      pulledDataset.description(),
      pulledDataset.id(),
      projectId,
      records,
      recordIds,
      datasetVersion,
      latestVersion
    )
  }

  // Build an experiment: { name, dataset, task, evaluators, description?, config?, tags? }.
  experiment (options) {
    return new Experiment(this.#client, options, this.#llmobs)
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
    const client = options?.projectName === undefined || options.projectName === this.#projectName
      ? this.#client
      : this.#clientForProject(options.projectName)
    return new Experiment(client, { ...options, external: true }).start()
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
  if (!config.llmobs?.mlApp && !config.service) {
    const reason = 'no project name configured; set the DD_LLMOBS_ML_APP environment variable (or llmobs.mlApp in ' +
      'tracer.init()) to name the LLM Obs project, or DD_SERVICE (or service in tracer.init()) as a fallback, ' +
      'then retry'
    const experiments = new Experiments(config, llmobs)
    return new NoopExperiments(reason, {
      startExperiment: (options) => experiments.startExperiment(options),
    })
  }
  return new Experiments(config, llmobs)
}

module.exports = { Experiments, createExperiments }
