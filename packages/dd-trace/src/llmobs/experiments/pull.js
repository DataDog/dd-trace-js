'use strict'

// Deserialisation of backend experiment resources for `pullExperiment` and
// `listExperiments`. Field mapping mirrors dd-trace-py's `ExperimentSummary`
// and `_parse_experiment_result`.

const { ExperimentResult, ExperimentRun, Row } = require('./result')
const { hasEntries, recordTagsToObject } = require('./util')

/**
 * @typedef {object} ExperimentSummary
 * @property {string} id
 * @property {string} name Run name assigned by the backend.
 * @property {string} experiment Logical experiment name.
 * @property {string} projectId
 * @property {string} datasetId
 * @property {number} datasetVersion
 * @property {string} description
 * @property {Record<string, unknown>} config
 * @property {number} runCount
 * @property {Record<string, string | string[]>} tags
 * @property {string | null} parentExperimentId
 * @property {Record<string, unknown> | null} aggregateData
 * @property {string | null} status
 * @property {string | null} error
 * @property {string | null} createdAt
 * @property {string | null} updatedAt
 */

/**
 * @typedef {object} EvaluationDetail
 * @property {unknown} value
 * @property {string} type
 * @property {string | null} reasoning
 * @property {string | null} assessment
 * @property {string | null} status
 * @property {unknown} error
 */

/**
 * @typedef {ExperimentSummary & {
 *   projectName: string,
 *   url: string,
 *   result: ExperimentResult,
 * }} PulledExperiment
 */

/**
 * @param {{ id?: unknown, attributes?: Record<string, unknown> }} resource
 * @returns {ExperimentSummary}
 */
function experimentSummaryFromResource (resource) {
  const attrs = resource?.attributes ?? {}
  const metadata = attrs.metadata ?? {}
  const tags = Array.isArray(metadata.tags) ? metadata.tags : []
  return {
    id: String(resource?.id ?? ''),
    name: String(attrs.name ?? ''),
    experiment: String(attrs.experiment ?? ''),
    projectId: String(attrs.project_id ?? ''),
    datasetId: String(attrs.dataset_id ?? ''),
    datasetVersion: Number(attrs.dataset_version ?? 0) || 0,
    description: String(attrs.description ?? ''),
    config: attrs.config ?? {},
    runCount: Number(attrs.run_count ?? 0) || 0,
    tags: recordTagsToObject(tags),
    parentExperimentId: attrs.parent_experiment_id ?? null,
    aggregateData: attrs.aggregate_data ?? null,
    status: attrs.status ?? null,
    error: attrs.error ?? null,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  }
}

/**
 * @param {Record<string, unknown>} metric
 * @returns {EvaluationDetail}
 */
function evaluationDetailFromMetric (metric) {
  const type = typeof metric.metric_type === 'string' ? metric.metric_type : 'score'
  return {
    value: metric[`${type}_value`],
    type,
    reasoning: metric.reasoning ?? null,
    assessment: metric.assessment ?? null,
    status: metric.status ?? null,
    error: metric.error ?? null,
  }
}

/**
 * Keep the latest metric per label (original run + re-runs may both be present).
 * @param {unknown} metrics
 * @returns {Record<string, EvaluationDetail>}
 */
function latestEvaluationsByLabel (metrics) {
  const details = {}
  const latestTs = new Map()
  if (!Array.isArray(metrics)) return details
  for (const metric of metrics) {
    const label = metric?.label
    if (typeof label !== 'string' || label === '') continue
    const ts = Number(metric.timestamp_ms ?? 0) || 0
    if (latestTs.has(label) && ts < latestTs.get(label)) continue
    latestTs.set(label, ts)
    details[label] = evaluationDetailFromMetric(metric)
  }
  return details
}

/**
 * @param {Record<string, EvaluationDetail>} details
 * @returns {{ evaluations: Record<string, unknown>, evaluationErrors: Record<string, string> }}
 */
function splitEvaluationDetails (details) {
  const evaluations = {}
  const evaluationErrors = {}
  for (const [label, detail] of Object.entries(details)) {
    const error = detail.error
    if (error !== null && error !== undefined && error !== '') {
      evaluationErrors[label] = typeof error === 'string' ? error : String(error.message ?? JSON.stringify(error))
    } else {
      evaluations[label] = detail.value
    }
  }
  return { evaluations, evaluationErrors }
}

/**
 * Convert an `/experiments/{id}/events` response into an `ExperimentResult`.
 * @param {Record<string, unknown>} response
 * @param {string} experimentId
 * @param {string} url
 * @returns {ExperimentResult}
 */
function parseExperimentEvents (response, experimentId, url) {
  const attributes = response?.data?.attributes ?? {}
  const spans = Array.isArray(attributes.spans) ? attributes.spans : []

  const rows = spans.map((span, index) => {
    const meta = span?.meta ?? {}
    const error = meta.error ?? {}
    const details = latestEvaluationsByLabel(span?.eval_metrics)
    const { evaluations, evaluationErrors } = splitEvaluationDetails(details)
    const errorType = error.type || null
    const errorMessage = error.message || null
    return new Row({
      index,
      spanId: span?.span_id ?? '',
      traceId: span?.trace_id ?? '',
      startNs: Number(span?.start_ns ?? 0) || 0,
      durationNs: Number(span?.duration ?? 0) || 0,
      input: meta.input ?? {},
      output: meta.output ?? null,
      expectedOutput: meta.expected_output ?? null,
      errorType: errorType ?? (errorMessage === null ? null : 'Error'),
      errorMessage,
      errorStack: error.stack || null,
      evaluations,
      evaluationErrors,
      evaluationDetails: details,
    })
  })

  const summaryEvaluations = {}
  const summaryMetrics = Array.isArray(attributes.summary_metrics) ? attributes.summary_metrics : []
  for (const metric of summaryMetrics) {
    const label = metric?.label
    if (typeof label !== 'string' || label === '') continue
    const detail = evaluationDetailFromMetric(metric)
    summaryEvaluations[label] = { value: detail.value, error: detail.error ?? null, ...detail }
  }

  const run = new ExperimentRun({
    runId: null,
    runIteration: 0,
    hasError: rows.some(row => row.isError || hasEntries(row.evaluationErrors)),
    rows,
    summaryEvaluations,
  })
  return new ExperimentResult(experimentId, rows, url, [run], summaryEvaluations)
}

module.exports = { experimentSummaryFromResource, parseExperimentEvents }
