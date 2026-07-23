'use strict'

const id = require('../../id')

const { API_BASE_PATH } = require('./client')
const { Row, ExperimentResult, ExperimentRun } = require('./result')

const EVALUATOR_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasEntries (value) {
  if (!value) return false
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

function validateEvaluatorName (name) {
  if (typeof name !== 'string') throw new TypeError('Evaluator name must be a string')
  if (name.length === 0) throw new Error('Evaluator name cannot be empty')
  if (!EVALUATOR_NAME_PATTERN.test(name)) {
    throw new Error(
      `Evaluator name '${name}' is invalid. Name must contain only alphanumeric characters, underscores, and hyphens.`
    )
  }
}

function functionName (fn, fallback) {
  return typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : fallback
}

function normalizeEvaluators (evaluators, kind) {
  if (evaluators == null) return []

  const normalized = []
  if (Array.isArray(evaluators)) {
    for (let i = 0; i < evaluators.length; i++) {
      const evaluator = evaluators[i]
      if (typeof evaluator !== 'function') throw new TypeError(`${kind} evaluator must be a function`)
      const name = functionName(evaluator, `${kind}_evaluator_${i}`)
      validateEvaluatorName(name)
      normalized.push([name, evaluator])
    }
    return normalized
  }

  if (!isPlainObject(evaluators)) {
    throw new TypeError(`${kind} evaluators must be an array of functions or an object keyed by evaluator name`)
  }

  for (const [name, evaluator] of Object.entries(evaluators)) {
    validateEvaluatorName(name)
    if (typeof evaluator !== 'function') throw new TypeError(`${kind} evaluator '${name}' must be a function`)
    normalized.push([name, evaluator])
  }
  return normalized
}

// Mirrors dd-trace-py's _generate_metric_from_evaluation: plain objects are
// json, everything else falls through to the lowercased categorical fallback.
function inferMetricType (value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return 'score'
  if (isPlainObject(value)) return 'json'
  return 'categorical'
}

function stringify (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.toLowerCase()
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase()
  return String(value).toLowerCase()
}

// Build the tag list, letting auto tags win over user tags on key conflict.
function buildTags (userTags, autoTags) {
  const tags = new Map()
  for (const [key, value] of Object.entries(userTags ?? {})) {
    tags.set(key, `${key}:${value}`)
  }
  for (const [key, value] of Object.entries(autoTags)) {
    if (value !== undefined && value !== null && value !== '') tags.set(key, `${key}:${value}`)
  }
  return [...tags.values()]
}

function buildExperimentTagObject (userTags, autoTags) {
  return userTags ? { ...userTags, ...autoTags } : { ...autoTags }
}

function sleep (ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildSpanMetadata (recordMetadata, config) {
  return recordMetadata
    ? { ...recordMetadata, experiment_config: config }
    : { experiment_config: config }
}

// One span per experiment row (LLM Obs experiment span wire format).
function toSpan (row, metadata, ids, spanName, userTags) {
  const meta = {
    input: row.input ?? null,
    output: row.output ?? null,
    expected_output: row.expectedOutput ?? null,
  }
  if (hasEntries(metadata)) {
    meta.metadata = metadata
  }
  if (row.isError) {
    meta.error = { type: row.errorType ?? '', message: row.errorMessage ?? '', stack: '' }
  }

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
    tags: buildTags(userTags, {
      experiment_id: ids.experimentId,
      run_id: ids.runId,
      run_iteration: ids.runIteration,
      dataset_id: ids.datasetId,
      dataset_record_id: ids.datasetRecordId,
    }),
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
  else if (type === 'json') metric.json_value = value
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

// Builder + run() orchestration: runs rows sequentially, emits one root span
// per dataset row, and posts spans + metrics to the experiments events API.
class Experiment {
  #client
  #llmobs
  #name
  #description
  #dataset
  #task
  #evaluators
  #summaryEvaluators
  #config
  #tags
  #experimentId

  constructor (client, options = {}, llmobs) {
    if (!options.name) throw new Error('Experiment name is required')
    if (!options.dataset) throw new Error('Experiment dataset is required')
    if (typeof options.task !== 'function') throw new Error('Experiment task is required')

    this.#client = client
    this.#llmobs = llmobs
    this.#name = options.name
    this.#description = options.description ?? ''
    this.#dataset = options.dataset
    this.#task = options.task
    this.#evaluators = normalizeEvaluators(options.evaluators, 'row')
    this.#summaryEvaluators = normalizeEvaluators(options.summaryEvaluators, 'summary')
    this.#config = { ...options.config }
    this.#tags = { ...options.tags }
    this.#experimentId = null
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

  async run (options = {}) {
    const {
      maxRetries = 0,
      retryDelay = (attempt) => 100 * (attempt + 1),
      raiseErrors = false,
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
    if (hasEntries(this.#config)) attributes.config = this.#config

    let created
    try {
      created = await this.#client.request('POST', `${API_BASE_PATH}/experiments`, {
        data: { type: 'experiments', attributes },
      })
    } catch (err) {
      throw new Error(`Failed to create experiment '${this.#name}': ${err.message}`)
    }
    this.#experimentId = created?.data?.id ?? null
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
      const usesLLMObsTrace = this.#usesLLMObsTrace()
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
          raiseErrors,
        })

        const timestampMs = Date.now()
        for (const [label, evaluator] of this.#evaluators) {
          if (row.isError) {
            const msg = 'task error; evaluation skipped'
            row.evaluationErrors[label] = msg
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
            if (!evaluatorResults[label]) evaluatorResults[label] = []
            evaluatorResults[label].push(value)
            metrics.push(toMetric(label, value, null, row.spanId, row.traceId, timestampMs, experimentId, this.#tags))
          } catch (err) {
            if (raiseErrors) throw err
            const msg = err.message ?? String(err)
            row.evaluationErrors[label] = msg
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
            runId,
            runIteration,
          }, this.#task.name || this.#name, this.#tags))
        }
      }

      const summaryEvaluations = await this.#runSummaryEvaluators(rows, records, evaluatorResults, {
        maxRetries,
        retryDelay,
        raiseErrors,
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
    raiseErrors,
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
    const tags = buildExperimentTagObject(this.#tags, autoTags)

    const execute = async () => {
      output = await this.#runWithRetries(
        () => this.#task(record.input, this.#config, record.metadata),
        maxRetries,
        retryDelay
      )
      return output
    }

    if (this.#usesLLMObsTrace()) {
      try {
        await this.#llmobs.annotationContext({ tags }, () => this.#llmobs.trace({
          kind: 'experiment',
          name: this.#task.name || this.#name,
        }, async (span) => {
          spanContext = this.#llmobs.exportSpan(span)
          try {
            await execute()
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
        }))
      } catch (err) {
        if (raiseErrors) throw err
        errorType = err.name || 'Error'
        errorMessage = err.message ?? String(err)
      }
    } else {
      try {
        await execute()
      } catch (err) {
        if (raiseErrors) throw err
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

  #usesLLMObsTrace () {
    return Boolean(this.#llmobs?.enabled && typeof this.#llmobs.trace === 'function')
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
        if (options.raiseErrors) throw err
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
    await this.#client.request('POST', `${API_BASE_PATH}/experiments/${experimentId}/events`, {
      data: { type: 'experiments', attributes },
    })
  }

  async #updateStatus (experimentId, status, error) {
    if (!experimentId) return
    // The experiment-update model has no status field, so this is a direct PATCH.
    const attributes = { status }
    if (error !== null) attributes.error = error
    try {
      await this.#client.request('PATCH', `${API_BASE_PATH}/experiments/${experimentId}`, {
        data: { type: 'experiments', attributes },
      })
    } catch {
      // Status update is best-effort; never let it mask the real result/error.
    }
  }
}

module.exports = { Experiment, normalizeEvaluators, validateEvaluatorName }
