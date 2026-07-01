'use strict'

const log = require('../../log')
const { ExperimentsClient, API_BASE_PATH } = require('./client')
const { Dataset, DatasetRecord } = require('./dataset')
const { Experiment } = require('./experiment')
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
  #projectName

  constructor (config) {
    this.#projectName = config.llmobs?.mlApp
    this.#client = new ExperimentsClient({
      apiKey: config.DD_API_KEY,
      appKey: config.DD_APP_KEY,
      site: config.site,
      projectName: this.#projectName,
    })
  }

  // Create a local dataset buffer. Pushed remotely on first experiment run.
  createDataset (name, description = '') {
    return new Dataset(this.#client, name, description)
  }

  // Pull an existing dataset by name (with its records). Polls with exponential
  // backoff to absorb read-after-write lag; pass `expectedRecordCount` to also
  // wait until that many records are readable.
  async pullDataset (name, options = {}) {
    const { expectedRecordCount, maxWaitMs = 30_000 } = options
    const projectId = await this.#client.ensureProjectId()

    let datasetId = null
    let description = ''
    let records = []
    let recordIds = []
    let lastError = ''

    const succeeded = await retryWithBackoff(async () => {
      try {
        if (datasetId === null) {
          const listed = await this.#client.request(
            'GET',
            `${API_BASE_PATH}/${projectId}/datasets?filter[name]=${encodeURIComponent(name)}`
          )
          for (const item of listed?.data ?? []) {
            if (item?.attributes?.name === name) {
              datasetId = String(item?.id ?? '')
              description = String(item?.attributes?.description ?? '')
              break
            }
          }
          if (datasetId === null) return false
        }

        const resp = await this.#client.request(
          'GET',
          `${API_BASE_PATH}/${projectId}/datasets/${datasetId}/records`
        )
        const recs = []
        const ids = []
        for (const item of resp?.data ?? []) {
          const attrs = item?.attributes ?? item
          recs.push(new DatasetRecord(attrs?.input ?? null, attrs?.expected_output ?? null, attrs?.metadata ?? {}))
          ids.push(String(item?.id ?? ''))
        }
        records = recs
        recordIds = ids

        return expectedRecordCount == null || recs.length >= expectedRecordCount
      } catch (err) {
        lastError = err.message
        return false
      }
    }, { maxTotalMs: maxWaitMs })

    if (datasetId === null) {
      if (lastError) {
        throw new Error(`Failed to list datasets in project '${this.#projectName}': ${lastError}`)
      }
      throw new Error(`Dataset '${name}' not found in project '${this.#projectName}' (after ${maxWaitMs}ms)`)
    }
    if (!succeeded && expectedRecordCount != null) {
      throw new Error(
        `Dataset '${name}' has ${records.length} record(s) after ${maxWaitMs}ms, expected ${expectedRecordCount} ` +
        '— backend may not have finished ingesting the push'
      )
    }

    return Dataset.fromExisting(this.#client, name, description, datasetId, projectId, records, recordIds)
  }

  // Build an experiment: { name, dataset, task, evaluators, description?, config?, tags? }.
  experiment (options) {
    return new Experiment(this.#client, options)
  }
}

// Factory used by the LLMObs SDK: returns a real Experiments instance when
// enabled and credentialed, otherwise a no-op that explains what's missing.
function createExperiments (config) {
  if (!config.llmobs?.DD_LLMOBS_ENABLED) {
    return new NoopExperiments('LLM Observability is not enabled')
  }
  if (!(config.DD_API_KEY) || !config.DD_APP_KEY) {
    log.warn('LLMObs experiments: missing api and/or app keys, set DD_API_KEY and DD_APP_KEY')
    return new NoopExperiments('DD_API_KEY and DD_APP_KEY are required for experiments')
  }
  return new Experiments(config)
}

module.exports = { Experiments, createExperiments }
