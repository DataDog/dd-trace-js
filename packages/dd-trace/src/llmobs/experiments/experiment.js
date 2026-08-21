'use strict'

const id = require('../../id')
const log = require('../../log')

const { Row, ExperimentResult, ExperimentRun } = require('./result')
const {
  buildSpanMetadata,
  buildTags,
  durationNs,
  generateRunId,
  hasEntries,
  inferMetricType,
  mergeTags,
  normalizeEvaluators,
  normalizeJsonMetricValue,
  normalizePositiveInteger,
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
  label, value, errorMessage, spanId, traceId, timestampMs, experimentId, userTags, source = 'custom', ids = {}
) {
  const metric = {
    metric_source: source,
    label,
    span_id: spanId,
    trace_id: traceId,
    timestamp_ms: timestampMs,
    tags: buildTags(userTags, {
      experiment_id: experimentId,
      run_id: ids.runId,
      run_iteration: ids.runIteration,
    }),
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

function createLimiter (concurrency) {
  const waiting = []
  let active = 0
  let cancelled = false
  let cancellationError

  const limit = async function limit (fn, cancelOnError = false) {
    if (cancelled) throw cancellationError
    if (active >= concurrency) {
      await new Promise((resolve, reject) => waiting.push({ resolve, reject }))
    }
    if (cancelled) throw cancellationError
    active++
    try {
      return await fn()
    } catch (error) {
      if (cancelOnError) limit.cancel(error)
      throw error
    } finally {
      active--
      const next = waiting.shift()
      if (next !== undefined) next.resolve()
    }
  }

  limit.cancel = (error) => {
    if (cancelled) return
    cancelled = true
    cancellationError = error
    const queued = [...waiting]
    waiting.length = 0
    for (const waiter of queued) waiter.reject(error)
  }

  return limit
}

// Builder + run() orchestration: emits one root span per dataset row and
// posts spans + metrics to the experiments events API.
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
  #runs
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
    this.#tags = { ...options.tags }
    this.#metadata = { ...options.metadata }
    this.#runs = this.#external ? 1 : normalizePositiveInteger(options.runs ?? 1, 'runs')
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
      payload.push(toMetric(
        metric.label,
        metric.value,
        metricError,
        span.spanId,
        span.traceId,
        timestampMs(metric.timestamp),
        experimentId,
        mergeTags(this.#tags, metric.tags),
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
      concurrency = 10,
    } = options

    if (maxRetries < 0) throw new Error('maxRetries must be >= 0')
    if (typeof retryDelay !== 'function') throw new TypeError('retryDelay must be a function')
    const concurrencyLimit = normalizePositiveInteger(concurrency, 'concurrency')

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
      run_count: this.#runs,
      metadata: { tags: buildTags(this.#tags, {}) },
    }
    const datasetVersion = this.#dataset.version()
    if (datasetVersion !== null) attributes.dataset_version = datasetVersion
    if (hasEntries(this.#config)) attributes.config = this.#config

    let created
    try {
      created = await this.#client.createExperiment(attributes)
    } catch (err) {
      throw new Error(`Failed to create experiment '${this.#name}': ${err.message}`)
    }
    this.#experimentId = created.experimentId
    const experimentId = this.#experimentId

    try {
      const records = this.#dataset.records()
      const recordIds = this.#dataset.recordIds()
      const usesLLMObsTrace = Boolean(this.#llmobs?.enabled)
      const runs = []
      let hasRunError = false

      for (let runIndex = 0; runIndex < this.#runs; runIndex++) {
        const runId = generateRunId()
        const runIteration = runIndex + 1
        // eslint-disable-next-line no-await-in-loop
        const result = await this.#runSingle({
          records,
          recordIds,
          projectId,
          datasetId,
          experimentId,
          runId,
          runIteration,
          maxRetries,
          retryDelay,
          throwOnErrors,
          concurrency: concurrencyLimit,
          usesLLMObsTrace,
        })
        runs.push(result.run)
        // Submit each run before starting the next iteration so results are available incrementally.
        // eslint-disable-next-line no-await-in-loop
        await this.#postEvents(experimentId, result.spans, result.metrics)
        this.#llmobs?.flush?.()
        if (result.hasRowError) hasRunError = true
      }

      // A row error doesn't abort the run, but the experiment didn't succeed cleanly.
      await this.#updateStatus(
        experimentId,
        hasRunError ? 'failed' : 'completed',
        hasRunError ? 'one or more rows failed' : null
      )

      const firstRun = runs[0]
      return new ExperimentResult(
        experimentId,
        firstRun?.rows ?? [],
        this.url(),
        runs,
        firstRun?.summaryEvaluations ?? {}
      )
    } catch (err) {
      await this.#updateStatus(experimentId, 'failed', err.message ?? String(err))
      throw err
    }
  }

  async #runSingle ({
    records,
    recordIds,
    projectId,
    datasetId,
    experimentId,
    runId,
    runIteration,
    maxRetries,
    retryDelay,
    throwOnErrors,
    concurrency,
    usesLLMObsTrace,
  }) {
    const limit = createLimiter(concurrency)
    const results = await this.#mapRecords(records, (index) => {
      const record = records[index]
      const datasetRecordId = index < recordIds.length ? recordIds[index] : ''
      return this.#processRecordWithEvaluators({
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
        limit,
      })
    }, limit)

    const rows = new Array(results.length)
    const spans = []
    const metrics = []
    const evaluatorResults = {}
    let hasRowError = false
    for (const [label] of this.#evaluators) evaluatorResults[label] = []

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const row = result.row
      rows[i] = row
      for (const [label] of this.#evaluators) {
        const value = Object.hasOwn(result.evaluatorValues, label) ? result.evaluatorValues[label] : null
        evaluatorResults[label].push(value)
      }
      for (const metric of result.metrics) metrics.push(metric)
      if (result.hasRowError) hasRowError = true
      if (!usesLLMObsTrace) {
        spans.push(toSpan(row, records[i].metadata, {
          experimentId,
          projectId,
          datasetId,
          datasetRecordId: i < recordIds.length ? recordIds[i] : '',
          datasetName: this.#dataset.name(),
          experimentName: this.#name,
          runId,
          runIteration,
        }, this.#task.name || this.#name, this.#tags, records[i].tags))
      }
    }

    const summaryEvaluations = await this.#runSummaryEvaluators(rows, records, evaluatorResults, {
      maxRetries,
      retryDelay,
      throwOnErrors,
      experimentId,
      runId,
      runIteration,
      metrics,
      limit,
    })
    if (hasEntries(summaryEvaluations)) {
      for (const value of Object.values(summaryEvaluations)) {
        if (value?.error !== null && value?.error !== undefined) hasRowError = true
      }
    }

    return {
      run: new ExperimentRun({ runId, runIteration, hasError: hasRowError, rows, summaryEvaluations }),
      spans,
      metrics,
      hasRowError,
    }
  }

  async #mapRecords (records, processRecord, limit) {
    const results = new Array(records.length)
    const pending = new Array(records.length)
    let firstError

    for (let i = 0; i < records.length; i++) {
      pending[i] = processRecord(i).then(
        result => { results[i] = result },
        err => {
          if (firstError === undefined) {
            firstError = err
            limit.cancel(err)
          }
        }
      )
    }

    await Promise.all(pending)
    if (firstError !== undefined) throw firstError
    return results
  }

  async #processRecordWithEvaluators ({
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
    limit,
  }) {
    const row = await limit(() => this.#processRecord({
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
    }), throwOnErrors)
    const timestampMs = Date.now()
    const metrics = []
    const evaluatorValues = {}
    let firstError

    const pending = new Array(this.#evaluators.length)
    for (let i = 0; i < this.#evaluators.length; i++) {
      const [label, evaluator] = this.#evaluators[i]
      pending[i] = this.#runRowEvaluator({
        label,
        evaluator,
        row,
        record,
        timestampMs,
        experimentId,
        runId,
        runIteration,
        maxRetries,
        retryDelay,
        throwOnErrors,
        limit,
      })
    }

    const evaluatorResults = await Promise.all(pending)
    for (const result of evaluatorResults) {
      if (result.metric !== null) metrics.push(result.metric)
      evaluatorValues[result.label] = result.value
      if (result.error !== undefined && firstError === undefined) firstError = result.error
    }
    if (firstError !== undefined) throw firstError

    return {
      row,
      metrics,
      evaluatorValues,
      hasRowError: row.isError || hasEntries(row.evaluationErrors),
    }
  }

  async #runRowEvaluator ({
    label,
    evaluator,
    row,
    record,
    timestampMs,
    experimentId,
    runId,
    runIteration,
    maxRetries,
    retryDelay,
    throwOnErrors,
    limit,
  }) {
    if (row.isError) {
      const msg = 'task error; evaluation skipped'
      row.evaluationErrors[label] = msg
      return {
        label,
        value: null,
        metric: toMetric(
          label,
          null,
          msg,
          row.spanId,
          row.traceId,
          timestampMs,
          experimentId,
          this.#tags,
          'custom',
          { runId, runIteration }
        ),
      }
    }

    try {
      const value = await limit(() => this.#runWithRetries(
        () => evaluator(record.input, row.output, record.expectedOutput),
        maxRetries,
        retryDelay
      ), throwOnErrors)
      row.evaluations[label] = value
      return {
        label,
        value,
        metric: toMetric(
          label,
          value,
          null,
          row.spanId,
          row.traceId,
          timestampMs,
          experimentId,
          this.#tags,
          'custom',
          { runId, runIteration }
        ),
      }
    } catch (err) {
      if (throwOnErrors) throw err
      const msg = err.message ?? String(err)
      row.evaluationErrors[label] = msg
      return {
        label,
        value: null,
        metric: toMetric(
          label,
          null,
          msg,
          row.spanId,
          row.traceId,
          timestampMs,
          experimentId,
          this.#tags,
          'custom',
          { runId, runIteration }
        ),
      }
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
    const pending = new Array(this.#summaryEvaluators.length)
    let firstError

    for (let i = 0; i < this.#summaryEvaluators.length; i++) {
      const [label, evaluator] = this.#summaryEvaluators[i]
      pending[i] = this.#runSummaryEvaluator({
        label,
        evaluator,
        inputs,
        outputs,
        expectedOutputs,
        evaluatorResults,
        metadata,
        timestampMs,
        options,
      })
    }

    let results
    try {
      results = await Promise.all(pending)
    } catch (err) {
      options.limit.cancel(err)
      throw err
    }
    for (const result of results) {
      if (result.error !== undefined) {
        if (firstError === undefined) firstError = result.error
        continue
      }
      summaryEvaluations[result.label] = result.evaluation
      options.metrics.push(result.metric)
    }
    if (firstError !== undefined) throw firstError

    return summaryEvaluations
  }

  async #runSummaryEvaluator ({
    label,
    evaluator,
    inputs,
    outputs,
    expectedOutputs,
    evaluatorResults,
    metadata,
    timestampMs,
    options,
  }) {
    try {
      const value = await options.limit(() => this.#runWithRetries(
        () => evaluator(inputs, outputs, expectedOutputs, evaluatorResults, metadata),
        options.maxRetries,
        options.retryDelay
      ), options.throwOnErrors)
      return {
        label,
        evaluation: { value, error: null },
        metric: toMetric(
          label,
          value,
          null,
          '',
          '',
          timestampMs,
          options.experimentId,
          this.#tags,
          'summary',
          { runId: options.runId, runIteration: options.runIteration }
        ),
      }
    } catch (err) {
      if (options.throwOnErrors) throw err
      const msg = err.message ?? String(err)
      return {
        label,
        evaluation: { value: null, error: msg },
        metric: toMetric(
          label,
          null,
          msg,
          '',
          '',
          timestampMs,
          options.experimentId,
          this.#tags,
          'summary',
          { runId: options.runId, runIteration: options.runIteration }
        ),
      }
    }
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
