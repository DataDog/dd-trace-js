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
    this.#projectName = config.llmobs?.mlApp || config.service
    this.#client = new ExperimentsClient({
      apiKey: config.DD_API_KEY,
      appKey: config.DD_APP_KEY,
      site: config.site,
      projectName: this.#projectName,
    })
  }

  // Create a local dataset buffer. Pushed remotely on first experiment run.
  createDataset (name, descriptionOrOptions = '') {
    const options = typeof descriptionOrOptions === 'string'
      ? { description: descriptionOrOptions }
      : (descriptionOrOptions ? { ...descriptionOrOptions } : {})
    const dataset = new Dataset(this.#client, name, options.description ?? '')
    for (const record of options.records ?? []) {
      dataset.addRecord(record.inputData, record.expectedOutput, record.metadata)
    }
    return dataset
  }

  // Pull an existing dataset by name (with its records). Polls with exponential
  // backoff to absorb read-after-write lag; pass `expectedRecordCount` to also
  // wait until that many records are readable.
  async pullDataset (name, options = {}) {
    const { expectedRecordCount, maxWaitMs = 30_000, version } = options
    const projectId = await this.#client.ensureProjectId()

    let datasetId = null
    let description = ''
    let records = []
    let recordIds = []
    let datasetVersion = version ?? null
    let latestVersion = null
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
              latestVersion = item?.attributes?.current_version ?? null
              datasetVersion = version ?? latestVersion
              break
            }
          }
          if (datasetId === null) return false
        }

        const recs = []
        const ids = []
        let cursor = ''
        // Follow the meta.after / page[cursor] pagination until the last page.
        for (;;) {
          const query = new URLSearchParams()
          if (cursor) query.set('page[cursor]', cursor)
          if (version !== undefined && version !== null) query.set('filter[version]', String(version))
          const queryString = query.toString() ? `?${query.toString()}` : ''
          // eslint-disable-next-line no-await-in-loop
          const resp = await this.#client.request(
            'GET',
            `${API_BASE_PATH}/${projectId}/datasets/${datasetId}/records${queryString}`
          )
          for (const item of resp?.data ?? []) {
            const attrs = item?.attributes ?? item
            recs.push(new DatasetRecord(attrs?.input ?? null, attrs?.expected_output ?? null, attrs?.metadata ?? {}))
            ids.push(String(item?.id ?? ''))
          }
          cursor = resp?.meta?.after ?? ''
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

    if (datasetId === null && lastError) {
      throw new Error(`Failed to list datasets in project '${this.#projectName}': ${lastError}`)
    }
    if (datasetId === null) {
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
      description,
      datasetId,
      projectId,
      records,
      recordIds,
      datasetVersion,
      latestVersion
    )
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
  if (!config.llmobs?.mlApp && !config.service) {
    log.warn('LLMObs experiments: no project name configured, set DD_LLMOBS_ML_APP or DD_SERVICE')
    return new NoopExperiments(
      'no project name configured; set the DD_LLMOBS_ML_APP environment variable (or llmobs.mlApp in ' +
      'tracer.init()) to name the LLM Obs project, or DD_SERVICE (or service in tracer.init()) as a fallback, ' +
      'then retry'
    )
  }
  return new Experiments(config)
}

module.exports = { Experiments, createExperiments }
