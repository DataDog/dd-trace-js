'use strict'

const { randomUUID } = require('node:crypto')

const { API_BASE_PATH } = require('./client')
const { Row, ExperimentResult } = require('./result')

// 32-char hex id (a UUIDv4 with the dashes stripped) for span/trace ids.
function hexId () {
  return randomUUID().replaceAll('-', '')
}

function inferMetricType (value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return 'score'
  return 'categorical'
}

function stringify (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Build the tag list, letting auto tags win over user tags on key conflict.
function buildTags (userTags, autoTags) {
  const tags = new Map()
  for (const [k, v] of Object.entries(userTags ?? {})) {
    tags.set(k, `${k}:${v}`)
  }
  for (const [k, v] of Object.entries(autoTags)) {
    tags.set(k, `${k}:${v}`)
  }
  return [...tags.values()]
}

// One span per experiment row (LLM Obs experiment span wire format).
function toSpan (row, metadata, ids, spanName, userTags) {
  const meta = {
    input: row.input ?? null,
    output: row.output ?? null,
    expected_output: row.expectedOutput ?? null,
  }
  if (metadata && Object.keys(metadata).length > 0) {
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
      dataset_id: ids.datasetId,
      dataset_record_id: ids.datasetRecordId,
    }),
  }
}

// One metric per evaluator per row.
function toMetric (label, value, errorMessage, spanId, timestampMs, experimentId, userTags) {
  const metric = {
    label,
    span_id: spanId,
    timestamp_ms: timestampMs,
    tags: buildTags(userTags, { experiment_id: experimentId }),
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
  else metric.categorical_value = stringify(value)
  return metric
}

// Builder + run() orchestration. v0.1 runs sequentially, emits one root span per
// dataset row, and posts all spans + metrics in a single events call.
class Experiment {
  #client
  #name
  #description
  #dataset
  #task
  #evaluators
  #config
  #tags
  #experimentId

  constructor (client, options = {}) {
    if (!options.name) throw new Error('Experiment name is required')
    if (!options.dataset) throw new Error('Experiment dataset is required')
    if (typeof options.task !== 'function') throw new Error('Experiment task is required')

    this.#client = client
    this.#name = options.name
    this.#description = options.description ?? ''
    this.#dataset = options.dataset
    this.#task = options.task
    this.#evaluators = new Map(Object.entries(options.evaluators ?? {}))
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

  async run () {
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
    }
    if (Object.keys(this.#config).length > 0) attributes.config = this.#config

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

    try {
      const records = this.#dataset.records()
      const recordIds = this.#dataset.recordIds()
      const rows = []
      const spans = []
      const metrics = []

      for (let i = 0; i < records.length; i++) {
        const record = records[i]
        const datasetRecordId = i < recordIds.length ? recordIds[i] : ''
        const spanId = hexId()
        const traceId = hexId()
        const startNs = Date.now() * 1e6
        const startHr = process.hrtime.bigint()

        let output = null
        let errorType = null
        let errorMessage = null
        try {
          // Sequential by design (v0.1): rows run one at a time.
          // eslint-disable-next-line no-await-in-loop
          output = await this.#task(record.input, this.#config)
        } catch (err) {
          errorType = err.name || 'Error'
          errorMessage = err.message ?? String(err)
        }

        const durationNs = Number(process.hrtime.bigint() - startHr)
        const evaluations = {}
        const evaluationErrors = {}
        const timestampMs = Date.now()

        for (const [label, evaluator] of this.#evaluators) {
          if (errorType !== null) {
            const msg = 'task error; evaluation skipped'
            evaluationErrors[label] = msg
            metrics.push(toMetric(label, null, msg, spanId, timestampMs, experimentId, this.#tags))
            continue
          }
          try {
            // eslint-disable-next-line no-await-in-loop
            const value = await evaluator(record.input, output, record.expectedOutput)
            evaluations[label] = value
            metrics.push(toMetric(label, value, null, spanId, timestampMs, experimentId, this.#tags))
          } catch (err) {
            const msg = err.message ?? String(err)
            evaluationErrors[label] = msg
            metrics.push(toMetric(label, null, msg, spanId, timestampMs, experimentId, this.#tags))
          }
        }

        const row = new Row({
          index: i,
          spanId,
          traceId,
          startNs,
          durationNs,
          input: record.input,
          output,
          expectedOutput: record.expectedOutput,
          errorType,
          errorMessage,
          evaluations,
          evaluationErrors,
        })
        rows.push(row)
        spans.push(toSpan(row, record.metadata, {
          experimentId,
          projectId,
          datasetId,
          datasetRecordId,
        }, this.#name, this.#tags))
      }

      await this.#postEvents(experimentId, spans, metrics)
      await this.#updateStatus(experimentId, 'completed', null)

      return new ExperimentResult(experimentId, rows, this.url())
    } catch (err) {
      await this.#updateStatus(experimentId, 'failed', err.message ?? String(err))
      throw err
    }
  }

  async #postEvents (experimentId, spans, metrics) {
    // W2: the events POST uses type "experiments".
    await this.#client.request('POST', `${API_BASE_PATH}/experiments/${experimentId}/events`, {
      data: { type: 'experiments', attributes: { spans, metrics } },
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

module.exports = { Experiment }
