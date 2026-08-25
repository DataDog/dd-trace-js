'use strict'

const id = require('../../id')
const log = require('../../log')

const { Row, ExperimentResult, ExperimentRun } = require('./result')
const {
  buildSpanMetadata,
  buildTags,
  durationNs,
  hasEntries,
  inferMetricType,
  normalizeEvaluators,
  mergeTags,
  normalizeJsonMetricValue,
  recordTagsToObject,
  sleep,
  stringify,
  timestampMs,
  validateEvaluatorName,
} = require('./util')

// One span per experiment row (LLM Obs experiment span wire format).
function toSpan (row, metadata, ids, spanName, userTags, recordTags) {
  const meta = {
    input: row.input ?? null,
    output: row.output ?? null,
    expected_output: row.expectedOutput ?? null,
  }
  if (hasEntries(metadata)) {
    meta.metadata = metadata
  }
  if (row.isError) {
    meta.error = { type: row.errorType ?? '', message: row.errorMessage ?? '', stack: row.errorStack ?? '' }
  }

  const tags = buildTags({
    ...userTags,
    ...recordTagsToObject(recordTags),
  }, {
    experiment_id: ids.experimentId,
    run_id: ids.runId,
    run_iteration: ids.runIteration,
    project_id: ids.projectId,
    dataset_id: ids.datasetId,
    dataset_record_id: ids.datasetRecordId,
    dataset_name: ids.datasetName,
    experiment_name: ids.experimentName,
    project_name: ids.projectName,
  })

  return {
    span_id: row.spanId,
    trace_id: row.traceId,
    project_id: ids.projectId,
    dataset_id: ids.datasetId,
    name: spanName,
    start_ns: row.startNs,
    duration: row.durationNs,
    status: row.isError ? 'error' : 'ok',
    meta,
    tags,
  }
}

// One metric per evaluator per row or summary evaluator.
function toMetric (
  label, value, errorMessage, spanId, traceId, timestampMs, experimentId, userTags, source = 'custom'
) {
  const metric = {
    metric_source: source,
    label,
    span_id: spanId,
    trace_id: traceId,
    timestamp_ms: timestampMs,
    tags: buildTags(userTags, { experiment_id: experimentId }),
    experiment_id: experimentId,
  }

  if (errorMessage !== null) {
    metric.metric_type = 'categorical'
    metric.error = { message: errorMessage }
    return metric
  }

  const type = inferMetricType(value)
  metric.metric_type = type
  if (type === 'boolean') metric.boolean_value = value
  else if (type === 'score') metric.score_value = value
  else if (type === 'json') metric.json_value = normalizeJsonMetricValue(value)
  else metric.categorical_value = stringify(value)
  return metric
}

function createFallbackSpanContext (startNs) {
  // Root-span id generation, same convention as opentracing/span.js: a single
  // random 64-bit id for the span, reused as the trace id's low 64 bits with a
  // start-time-derived high 64 bits (like the `_dd.p.tid` 128-bit trace id tag).
  const spanIdentifier = id()
  const traceIdHigh = Math.floor(startNs / 1e9).toString(16).padStart(8, '0').padEnd(16, '0')
  const spanId = spanIdentifier.toString(16).padStart(16, '0')
  const traceId = spanIdentifier.toTraceIdHex(traceIdHigh).padStart(32, '0')
  return { spanId, traceId }
}

function normalizeError (error) {
  if (error == null) {
    return { errorType: null, errorMessage: null, errorStack: '' }
  }

  if (typeof error === 'string') {
    return { errorType: 'Error', errorMessage: error, errorStack: '' }
  }

  return {
    errorType: error.type ?? error.name ?? 'Error',
    errorMessage: error.message ?? String(error),
    errorStack: error.stack ?? '',
  }
}

function errorMessage (error) {
  if (error == null) return null
  if (typeof error === 'string') return error
  return error.message ?? String(error)
}

// Builder + run() orchestration: runs rows sequentially, emits one root span
// per dataset row, and posts spans + metrics to the experiments events API.
class Experiment {
  #client
  #llmobs
  #external
  #name
  #description
  #dataset
  #task
  #evaluators
  #summaryEvaluators
  #config
  #tags
  #metadata
  #projectName
  #projectId
  #experimentId
  #runId
  #runIteration

  constructor (client, options = {}, llmobs) {
    if (!options.name) throw new Error('Experiment name is required')
    this.#external = options.external === true
    if (!this.#external) {
      if (!options.dataset) throw new Error('Experiment dataset is required')
      if (typeof options.task !== 'function') throw new Error('Experiment task is required')
    }

    this.#client = client
    this.#llmobs = llmobs
    this.#name = options.name
    this.#description = options.description ?? ''
    this.#dataset = options.dataset ?? {}
    this.#task = options.task
    this.#evaluators = normalizeEvaluators(options.evaluators, 'row')
    this.#summaryEvaluators = normalizeEvaluators(options.summaryEvaluators, 'summary')
    this.#config = { ...options.config }
    const filterTags = this.#dataset.filterTags?.() ?? []
    if (filterTags.length > 0) this.#config.filtered_record_tags = filterTags
    this.#projectName = options.projectName
    this.#tags = { ...options.tags }
    if (this.#projectName !== undefined) this.#tags.project_name = this.#projectName
    this.#metadata = { ...options.metadata }
    this.#projectId = null
    this.#experimentId = null
    this.#runId = null
    this.#runIteration = null
  }

  name () {
    return this.#name
  }

  experimentId () {
    return this.#experimentId
  }

  url () {
    if (this.#experimentId === null) return null
    return `${this.#client.appBase}/llm/experiments/${this.#experimentId}`
  }

  /**
   * @returns {Promise<Experiment>}
   */
  async start () {
    if (!this.#external) throw new Error('Experiment is not externally driven')

    this.#projectId = await this.#client.ensureProjectId()

    const dataset = await this.#ensureExternalDataset()
    const attributes = {
      name: this.#name,
      project_id: this.#projectId,
      dataset_id: dataset.id,
      description: this.#description,
      ensure_unique: true,
      run_count: 1,
    }
    if (dataset.version != null) attributes.dataset_version = dataset.version
    if (hasEntries(this.#config)) attributes.config = this.#config

    const metadata = { ...this.#metadata }
    if (hasEntries(this.#tags)) metadata.tags = buildTags(this.#tags, {})
    if (hasEntries(metadata)) attributes.metadata = metadata

    let created
    try {
      created = await this.#client.createExperiment(attributes)
    } catch (err) {
      throw new Error(`Failed to create experiment '${this.#name}': ${err.message}`)
    }
    this.#experimentId = created.experimentId
    this.#runId = id().toString(16).padStart(16, '0')
    this.#runIteration = 0
    return this
  }

  async #ensureExternalDataset () {
    if (this.#dataset.id) {
      return { id: this.#dataset.id, version: this.#dataset.version }
    }

    const name = this.#dataset.name ?? `${this.#name} dataset`
    const description = this.#dataset.description ??
      `Placeholder dataset for externally-driven experiment '${this.#name}'`
    let response
    try {
      response = await this.#client.createDataset(this.#projectId, { name, description })
    } catch (err) {
      throw new Error(`Failed to create placeholder dataset '${name}': ${err.message}`)
    }

    const id = response.id()
    if (id === null) {
      throw new Error(`Failed to create placeholder dataset '${name}': backend response is missing dataset id`)
    }

    this.#dataset = {
      ...this.#dataset,
      id,
      version: this.#dataset.version ?? response.version(),
    }
    return { id: this.#dataset.id, version: this.#dataset.version }
  }

  /**
   * @param {object} input
   * @returns {Promise<{experimentId: string, spanId: string, traceId: string, url: string | null}>}
   */
  async submitSpan (input = {}) {
    if (this.#experimentId === null || this.#projectId === null) {
      throw new Error('Experiment has not been started')
    }

    const startMs = timestampMs(input.startedAt)
    const startNs = Math.round(startMs * 1e6)
    const { spanId, traceId } = createFallbackSpanContext(startNs)
    const error = normalizeError(input.error)
    const row = new Row({
      spanId,
      traceId,
      startNs,
      durationNs: durationNs(input, startMs),
      input: input.input,
      output: input.output,
      expectedOutput: input.expectedOutput,
      errorType: error.errorType,
      errorMessage: error.errorMessage,
      errorStack: error.errorStack,
      evaluations: {},
      evaluationErrors: {},
    })

    const span = toSpan(row, input.metadata, {
      experimentId: this.#experimentId,
      projectId: this.#projectId,
      datasetId: this.#dataset.id,
      datasetRecordId: input.datasetRecordId,
      projectName: this.#projectName,
      runId: input.runId ?? this.#runId,
      runIteration: input.runIteration ?? this.#runIteration,
    }, input.name ?? this.#name, mergeTags(this.#tags, input.tags))

    await this.#postEvents(this.#experimentId, [span], [])

    return {
      experimentId: this.#experimentId,
      spanId,
      traceId,
      url: this.url(),
    }
  }

  /**
   * @param {{experimentId?: string, spanId: string, traceId?: string}} span
   * @param {object[]} metrics
   * @returns {Promise<void>}
   */
  async submitEvaluationMetrics (span, metrics) {
    if (this.#experimentId === null) {
      throw new Error('Experiment has not been started')
    }
    if (!span?.spanId) {
      throw new Error('Experiment span id is required')
    }

    const experimentId = span.experimentId ?? this.#experimentId
    if (experimentId !== this.#experimentId) {
      throw new Error(`Experiment span belongs to '${experimentId}', not '${this.#experimentId}'`)
    }
    if (!span.traceId) {
      throw new Error('Experiment trace id is required')
    }

    const payload = []
    for (const metric of metrics) {
      validateEvaluatorName(metric.label)
      const metricError = errorMessage(metric.error)
      if (metric.value === undefined && metricError == null) {
        log.warn('LLMObs experiments: skipping external metric %s because it has neither value nor error', metric.label)
        continue
      }
      const metricTags = mergeTags(this.#tags, metric.tags)
      if (this.#projectName !== undefined) metricTags.project_name = this.#projectName
      payload.push(toMetric(
        metric.label,
        metric.value,
        metricError,
        span.spanId,
        span.traceId,
        timestampMs(metric.timestamp),
        experimentId,
        metricTags,
        metric.source ?? 'custom'
      ))
    }

    if (payload.length === 0) return
    await this.#postEvents(experimentId, [], payload)
  }

  /**
   * @param {object} options
   * @returns {Promise<void>}
   */
  async close (options = {}) {
    if (this.#experimentId === null) return
    const error = errorMessage(options.error)
    const status = options.status ?? (error === null ? 'completed' : 'failed')
    await this.#updateStatus(this.#experimentId, status, error, false)
  }

  async run (options = {}) {
    if (this.#external) throw new Error('Externally-driven experiments cannot run local tasks')

    const {
      maxRetries = 0,
      retryDelay = (attempt) => 100 * (attempt + 1),
      throwOnErrors = false,
    } = options

    if (maxRetries < 0) throw new Error('maxRetries must be >= 0')
    if (typeof retryDelay !== 'function') throw new TypeError('retryDelay must be a function')

    const projectId = await this.#client.ensureProjectId()

    await this.#dataset.ensureCreatedAndPushed(projectId)
    const datasetId = this.#dataset.id()
    if (datasetId === null) {
      throw new Error(`Dataset '${this.#dataset.name()}' has no id after push`)
    }

    // Create the experiment. ensure_unique makes the backend mint a fresh
    // experiment under the project on every run.
    const attributes = {
      name: this.#name,
      project_id: projectId,
      dataset_id: datasetId,
      description: this.#description,
      ensure_unique: true,
      run_count: 1,
      metadata: { tags: buildTags(this.#tags, {}) },
    }
    const datasetVersion = this.#dataset.version()
    if (datasetVersion !== null) attributes.dataset_version = datasetVersion
    // eslint-disable-next-line no-restricted-syntax -- faster than tracking entries while copying arbitrary config
    if (Object.keys(this.#config).length > 0) attributes.config = this.#config

    let created
    try {
      created = await this.#client.createExperiment(attributes)
    } catch (err) {
      throw new Error(`Failed to create experiment '${this.#name}': ${err.message}`)
    }
    this.#experimentId = created.experimentId
    const experimentId = this.#experimentId
    const runId = id().toString(16).padStart(16, '0')
    const runIteration = 0

    try {
      const records = this.#dataset.records()
      const recordIds = this.#dataset.recordIds()
      const rows = []
      const spans = []
      const metrics = []
      const evaluatorResults = {}
      const usesLLMObsTrace = Boolean(this.#llmobs?.enabled)
      let hasRowError = false

      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        const datasetRecordId = i < recordIds.length ? recordIds[i] : ''
        // Rows currently run sequentially by design; jobs/concurrency is a P1 follow-up.
        // eslint-disable-next-line no-await-in-loop
        const row = await this.#processRecord({
          index: i,
          record,
          datasetRecordId,
          projectId,
          datasetId,
          experimentId,
          runId,
          runIteration,
          maxRetries,
          retryDelay,
          throwOnErrors,
        })

        const timestampMs = Date.now()
        for (const [label, evaluator] of this.#evaluators) {
          if (!evaluatorResults[label]) evaluatorResults[label] = []
          if (row.isError) {
            const msg = 'task error; evaluation skipped'
            row.evaluationErrors[label] = msg
            evaluatorResults[label].push(null)
            metrics.push(toMetric(label, null, msg, row.spanId, row.traceId, timestampMs, experimentId, this.#tags))
            continue
          }
          try {
            // eslint-disable-next-line no-await-in-loop
            const value = await this.#runWithRetries(
              () => evaluator(record.input, row.output, record.expectedOutput),
              maxRetries,
              retryDelay
            )
            row.evaluations[label] = value
            evaluatorResults[label].push(value)
            metrics.push(toMetric(label, value, null, row.spanId, row.traceId, timestampMs, experimentId, this.#tags))
          } catch (err) {
            if (throwOnErrors) throw err
            const msg = err.message ?? String(err)
            row.evaluationErrors[label] = msg
            evaluatorResults[label].push(null)
            metrics.push(toMetric(label, null, msg, row.spanId, row.traceId, timestampMs, experimentId, this.#tags))
          }
        }

        rows.push(row)
        if (row.isError || hasEntries(row.evaluationErrors)) hasRowError = true
        if (!usesLLMObsTrace) {
          spans.push(toSpan(row, record.metadata, {
            experimentId,
            projectId,
            datasetId,
            datasetRecordId,
            datasetName: this.#dataset.name(),
            experimentName: this.#name,
            projectName: this.#projectName,
            runId,
            runIteration,
          }, this.#task.name || this.#name, this.#tags, record.tags))
        }
      }

      const summaryEvaluations = await this.#runSummaryEvaluators(rows, records, evaluatorResults, {
        maxRetries,
        retryDelay,
        throwOnErrors,
        experimentId,
        metrics,
      })
      if (hasEntries(summaryEvaluations)) {
        for (const value of Object.values(summaryEvaluations)) {
          if (value?.error) hasRowError = true
        }
      }

      await this.#postEvents(experimentId, spans, metrics)
      this.#llmobs?.flush?.()
      // A row error doesn't abort the run, but the experiment didn't succeed cleanly.
      await this.#updateStatus(
        experimentId,
        hasRowError ? 'failed' : 'completed',
        hasRowError ? 'one or more rows failed' : null
      )

      const run = new ExperimentRun({ runId, runIteration, rows, summaryEvaluations })
      return new ExperimentResult(experimentId, rows, this.url(), [run], summaryEvaluations)
    } catch (err) {
      await this.#updateStatus(experimentId, 'failed', err.message ?? String(err))
      throw err
    }
  }

  async #processRecord ({
    index,
    record,
    datasetRecordId,
    projectId,
    datasetId,
    experimentId,
    runId,
    runIteration,
    maxRetries,
    retryDelay,
    throwOnErrors,
  }) {
    const startNs = Date.now() * 1e6
    const startHr = process.hrtime.bigint()
    const fallbackContext = createFallbackSpanContext(startNs)
    let spanContext = fallbackContext
    let output = null
    let errorType = null
    let errorMessage = null

    const autoTags = {
      experiment_id: experimentId,
      run_id: runId,
      run_iteration: runIteration,
      project_id: projectId,
      dataset_id: datasetId,
      dataset_record_id: datasetRecordId,
      dataset_name: this.#dataset.name(),
      experiment_name: this.#name,
    }
    if (this.#projectName !== undefined) autoTags.project_name = this.#projectName
    const tags = mergeTags(this.#tags, { ...recordTagsToObject(record.tags), ...autoTags })

    const execute = () => this.#runWithRetries(
      () => this.#task(record.input, this.#config, record.metadata),
      maxRetries,
      retryDelay
    )

    if (this.#llmobs?.enabled) {
      try {
        await this.#llmobs.trace({
          kind: 'experiment',
          name: this.#task.name || this.#name,
        }, async (span) => {
          spanContext = this.#llmobs.exportSpan(span)
          try {
            output = await execute()
          } catch (err) {
            this.#llmobs.annotate(span, {
              inputData: record.input,
              outputData: output,
              metadata: buildSpanMetadata(record.metadata, this.#config),
              tags,
            })
            throw err
          }
          this.#llmobs.annotate(span, {
            inputData: record.input,
            outputData: output,
            metadata: buildSpanMetadata(record.metadata, this.#config),
            tags,
          })
        })
      } catch (err) {
        if (throwOnErrors) throw err
        errorType = err.name || 'Error'
        errorMessage = err.message ?? String(err)
      }
    } else {
      try {
        output = await execute()
      } catch (err) {
        if (throwOnErrors) throw err
        errorType = err.name || 'Error'
        errorMessage = err.message ?? String(err)
      }
    }

    const durationNs = Number(process.hrtime.bigint() - startHr)
    return new Row({
      index,
      spanId: spanContext?.spanId ?? fallbackContext.spanId,
      traceId: spanContext?.traceId ?? fallbackContext.traceId,
      startNs,
      durationNs,
      input: record.input,
      output,
      expectedOutput: record.expectedOutput,
      errorType,
      errorMessage,
      evaluations: {},
      evaluationErrors: {},
    })
  }

  async #runWithRetries (fn, maxRetries, retryDelay) {
    let lastError
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await fn()
      } catch (err) {
        lastError = err
        if (attempt >= maxRetries) break
        const delayMs = retryDelay(attempt)
        if (typeof delayMs !== 'number' || delayMs < 0 || !Number.isFinite(delayMs)) {
          throw new TypeError('retryDelay must return a non-negative finite number of milliseconds')
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(delayMs)
      }
    }
    throw lastError
  }

  async #runSummaryEvaluators (rows, records, evaluatorResults, options) {
    if (this.#summaryEvaluators.length === 0) return {}

    const inputs = rows.map(row => row.input)
    const outputs = rows.map(row => row.output)
    const expectedOutputs = rows.map(row => row.expectedOutput)
    const metadata = records.map(record => buildSpanMetadata(record.metadata, this.#config))
    const summaryEvaluations = {}
    const timestampMs = Date.now()

    for (const [label, evaluator] of this.#summaryEvaluators) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const value = await this.#runWithRetries(
          () => evaluator(inputs, outputs, expectedOutputs, evaluatorResults, metadata),
          options.maxRetries,
          options.retryDelay
        )
        summaryEvaluations[label] = { value, error: null }
        options.metrics.push(toMetric(
          label,
          value,
          null,
          '',
          '',
          timestampMs,
          options.experimentId,
          this.#tags,
          'summary'
        ))
      } catch (err) {
        if (options.throwOnErrors) throw err
        const msg = err.message ?? String(err)
        summaryEvaluations[label] = { value: null, error: msg }
        options.metrics.push(toMetric(
          label,
          null,
          msg,
          '',
          '',
          timestampMs,
          options.experimentId,
          this.#tags,
          'summary'
        ))
      }
    }
    return summaryEvaluations
  }

  async #postEvents (experimentId, spans, metrics) {
    const attributes = { metrics }
    if (spans.length > 0) attributes.spans = spans
    await this.#client.postExperimentEvents(experimentId, attributes)
  }

  async #updateStatus (experimentId, status, error, suppressErrors = true) {
    if (!experimentId) return
    // The experiment-update model has no status field, so this is a direct PATCH.
    const attributes = { status }
    if (error !== null) attributes.error = error
    try {
      await this.#client.updateExperiment(experimentId, attributes)
    } catch (err) {
      if (!suppressErrors) throw err
      // Status update is best-effort; never let it mask the real result/error.
    }
  }
}

class ExternalExperiment {
  #experiment

  /**
   * @param {Pick<Experiment, 'name' | 'experimentId' | 'url' | 'submitSpan' | 'submitEvaluationMetrics' |
   *   'close'>} experiment
   */
  constructor (experiment) {
    this.#experiment = experiment
  }

  /**
   * @returns {string}
   */
  name () {
    return this.#experiment.name()
  }

  /**
   * @returns {string | null}
   */
  experimentId () {
    return this.#experiment.experimentId()
  }

  /**
   * @returns {string | null}
   */
  url () {
    return this.#experiment.url()
  }

  /**
   * @param {object} [input]
   * @returns {Promise<object>}
   */
  submitSpan (input) {
    return this.#experiment.submitSpan(input)
  }

  /**
   * @param {object} span
   * @param {object[]} metrics
   * @returns {Promise<void>}
   */
  submitEvaluationMetrics (span, metrics) {
    return this.#experiment.submitEvaluationMetrics(span, metrics)
  }

  /**
   * @param {object} [options]
   * @returns {Promise<void>}
   */
  close (options) {
    return this.#experiment.close(options)
  }
}

module.exports = { Experiment, ExternalExperiment, normalizeEvaluators, validateEvaluatorName }
