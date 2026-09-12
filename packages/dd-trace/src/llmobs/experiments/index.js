'use strict'

const fs = require('node:fs')

const log = require('../../log')
const { ExperimentsClient } = require('./client')
const { readCsvRecords } = require('./csv')
const { Dataset, DatasetRecord } = require('./dataset')
const { Experiment, ExternalExperiment } = require('./experiment')
const { experimentSummaryFromResource, parseExperimentEvents } = require('./pull')
const { validateTagsList } = require('./util')
const NoopExperiments = require('./noop')

const DEFAULT_PROJECT_NAME = 'default-project'

/**
 * @param {string[] | undefined} columns
 * @param {string} label
 * @returns {string[]}
 */
function normalizeColumns (columns, label) {
  if (columns === undefined || columns === null) return []
  if (!Array.isArray(columns) || columns.some(column => typeof column !== 'string')) {
    throw new TypeError(`${label} must be an array of column names`)
  }
  return columns
}

/**
 * @param {Record<string, string>} row
 * @param {string[]} columns
 * @returns {Record<string, string>}
 */
function pickColumns (row, columns) {
  const picked = {}
  for (const column of columns) picked[column] = row[column]
  return picked
}

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
    if ((options.records) != null) dataset.addRecords(options.records)
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

  /**
   * Publish an LLM-as-a-judge evaluator as a custom evaluator configuration so it
   * can run server-side. The evaluator is published disabled.
   *
   * @param {{ buildPublishPayload: (mlApp: string, evalName?: string,
   *   variableMapping?: Record<string, string>) => Record<string, unknown> }} evaluator
   * @param {object} [options]
   * @param {string} [options.agentService] Agent service (ML app) the evaluator is attached to.
   *   Defaults to the tracer's `llmobs.mlApp` / `service`.
   * @param {string} [options.mlApp] Deprecated alias of `agentService`.
   * @param {string} [options.evalName] Published name; defaults to `evaluator.name`.
   * @param {Record<string, string>} [options.variableMapping] Renames `{{placeholders}}` in the prompt.
   * @returns {Promise<{ uiUrl: string }>}
   */
  async publishEvaluator (evaluator, { agentService, mlApp, evalName, variableMapping } = {}) {
    if (evaluator === null || typeof evaluator !== 'object' || typeof evaluator.buildPublishPayload !== 'function') {
      throw new TypeError('evaluator must be a publishable evaluator such as LLMJudge')
    }
    if (mlApp !== undefined && agentService === undefined) {
      log.warn('LLMObs experiments: publishEvaluator option `mlApp` is deprecated, use `agentService`')
    }
    const resolved = agentService ?? mlApp ?? this.#config.llmobs?.mlApp ?? this.#config.service
    if (typeof resolved !== 'string' || resolved.trim() === '') {
      throw new Error('`agentService` must be provided as a non-empty string.')
    }
    const application = resolved.trim()
    const evaluation = evaluator.buildPublishPayload(application, evalName, variableMapping)
    const client = this.#clientForOperation()
    await client.publishCustomEvaluator(evaluation)
    const query = new URLSearchParams({ evalName: evaluation.eval_name, applicationName: application })
    return { uiUrl: `${client.appBase}/llm/evaluations/custom?${query.toString()}` }
  }

  /**
   * Fetch a previously-run experiment by id, including its rows and evaluation metrics.
   *
   * @param {string} experimentId
   * @returns {Promise<import('./pull').PulledExperiment>}
   */
  async pullExperiment (experimentId) {
    if (typeof experimentId !== 'string' || experimentId === '') throw new Error('experimentId is required.')
    const client = this.#clientForOperation()
    const [meta, events] = await Promise.all([
      client.getExperiment(experimentId),
      client.getExperimentEvents(experimentId),
    ])
    const summary = experimentSummaryFromResource(meta)
    const url = `${client.appBase}/llm/experiments/${summary.id}`
    const taggedProjectName = summary.tags.project_name
    return {
      ...summary,
      projectName: typeof taggedProjectName === 'string' ? taggedProjectName : this.#projectName,
      url,
      result: parseExperimentEvents(events, summary.id, url),
    }
  }

  /**
   * List experiments in a project, newest first.
   *
   * @param {object} [options]
   * @param {string} [options.experimentName]
   * @param {Record<string, unknown>} [options.metadataFilter] e.g. `{ tags: ['git.commit.sha:abc'] }`.
   * @param {string[]} [options.parentExperimentIds]
   * @param {string} [options.projectName] Defaults to the configured project.
   * @param {number} [options.pageLimit] Page size (1-5000, default 100).
   * @param {number} [options.maxResults] Stop after this many experiments (default: all pages).
   * @returns {Promise<import('./pull').ExperimentSummary[]>}
   */
  async listExperiments ({
    experimentName,
    metadataFilter,
    parentExperimentIds,
    projectName,
    pageLimit = 100,
    maxResults,
  } = {}) {
    if (maxResults !== undefined && maxResults !== null && maxResults < 1) {
      throw new Error(`max_results must be at least 1, got ${maxResults}`)
    }
    const client = this.#clientForOperation(projectName)
    const resolvedProjectName = projectName ?? this.#projectName
    let projectId
    try {
      projectId = await client.ensureProjectId()
    } catch (err) {
      throw new Error(`Failed to resolve project '${resolvedProjectName}' for listExperiments(): ${err.message}`)
    }
    if (!projectId) throw new Error(`Got no project ID for project '${resolvedProjectName}' in listExperiments()`)
    const resources = await client.listExperiments({
      experimentName,
      metadataFilter,
      parentExperimentIds,
      projectId,
      pageLimit,
      maxResults,
    })
    return resources.map(experimentSummaryFromResource)
  }

  /**
   * Create a dataset from a CSV file and bulk-upload its rows in one request.
   *
   * @param {object} options
   * @param {string} options.csvPath
   * @param {string} options.datasetName
   * @param {string[]} options.inputDataColumns
   * @param {string[]} [options.expectedOutputColumns]
   * @param {string[]} [options.metadataColumns]
   * @param {string} [options.csvDelimiter] Default `,`.
   * @param {string} [options.description]
   * @param {string} [options.projectName]
   * @param {boolean} [options.deduplicate] Default `true`.
   * @param {string} [options.idColumn] Column used as the record id.
   * @returns {Promise<Dataset>}
   */
  async createDatasetFromCsv ({
    csvPath,
    datasetName,
    inputDataColumns,
    expectedOutputColumns,
    metadataColumns,
    csvDelimiter = ',',
    description = '',
    projectName,
    deduplicate = true,
    idColumn,
  } = {}) {
    if (typeof csvPath !== 'string' || csvPath === '') throw new Error('csvPath is required')
    if (typeof datasetName !== 'string' || datasetName === '') throw new Error('datasetName is required')
    const inputColumns = normalizeColumns(inputDataColumns, 'inputDataColumns')
    if (inputColumns.length === 0) throw new Error('inputDataColumns must contain at least one column')
    const outputColumns = normalizeColumns(expectedOutputColumns, 'expectedOutputColumns')
    const metaColumns = normalizeColumns(metadataColumns, 'metadataColumns')

    const { header, rows } = readCsvRecords(await fs.promises.readFile(csvPath, 'utf8'), csvDelimiter)
    const headerSet = new Set(header)
    const missingInput = inputColumns.filter(column => !headerSet.has(column))
    if (missingInput.length > 0) {
      throw new Error(`Input columns not found in CSV header: ${JSON.stringify(missingInput)}`)
    }
    const missingOutput = outputColumns.filter(column => !headerSet.has(column))
    if (missingOutput.length > 0) {
      throw new Error(`Expected output columns not found in CSV header: ${JSON.stringify(missingOutput)}`)
    }
    const missingMeta = metaColumns.filter(column => !headerSet.has(column))
    if (missingMeta.length > 0) {
      throw new Error(`Metadata columns not found in CSV header: ${JSON.stringify(missingMeta)}`)
    }
    if (idColumn && !headerSet.has(idColumn)) throw new Error(`ID column '${idColumn}' not found in CSV header`)

    const records = rows.map(row => new DatasetRecord(
      pickColumns(row, inputColumns),
      pickColumns(row, outputColumns),
      pickColumns(row, metaColumns),
      idColumn ? row[idColumn] : null,
      []
    ))

    const client = this.#clientForOperation(projectName)
    const projectId = await client.ensureProjectId()
    let created
    try {
      created = await client.createDataset(projectId, { name: datasetName, description })
    } catch (err) {
      throw new Error(`Failed to create dataset '${datasetName}': ${err.message}`)
    }
    const datasetId = created.id()
    if (!datasetId) throw new Error(`Failed to create dataset '${datasetName}': backend response is missing dataset id`)
    if (records.length > 0) await client.bulkUploadDatasetRecords(datasetId, records, deduplicate)

    return Dataset.fromExisting(
      client,
      datasetName,
      description,
      datasetId,
      projectId,
      records,
      created.latestVersion(),
      created.latestVersion()
    )
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
