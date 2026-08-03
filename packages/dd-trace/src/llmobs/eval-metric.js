'use strict'

const tracerVersion = require('../../../../package.json').version

/**
 * Kind of event submitted through the evaluation metrics intake. Both kinds share the
 * writer, the endpoint and most of their validation, and are told apart on the wire by
 * the `event_kind` field.
 * @typedef {'evaluation' | 'feedback'} MetricEventKind
 */

/**
 * Tag value the intake accepts: a string, or anything the SDK can coerce through `toString()`.
 * @typedef {string | { toString?: unknown }} MetricTagValue
 */

/** @type {string[]} */
const EVALUATION_METRIC_TYPES = ['categorical', 'score', 'boolean', 'json']

/**
 * End-user feedback additionally accepts free-form text values.
 * @type {string[]}
 */
const FEEDBACK_METRIC_TYPES = [...EVALUATION_METRIC_TYPES, 'text']

/** @type {Record<MetricEventKind, string[]>} */
const METRIC_TYPES = {
  evaluation: EVALUATION_METRIC_TYPES,
  feedback: FEEDBACK_METRIC_TYPES,
}

/**
 * Feedback target option accepted by the SDK, mapped to the payload key it is sent as. `span` and
 * `spanId` are two ways of naming the same target.
 * @type {Record<string, string>}
 */
const FEEDBACK_TARGET_KEYS = {
  span: 'span_id',
  spanId: 'span_id',
  traceId: 'trace_id',
  sessionId: 'session_id',
  feedbackJoinKey: 'feedback_join_key',
}

// The validation is shared but the user-facing wording is per-kind. Keeping the terms in one
// table avoids threading three near-identical strings through every validator.
/** @type {Record<MetricEventKind, { metric: string, metrics: string, data: string }>} */
const TERMS = {
  evaluation: {
    metric: 'evaluation metric',
    metrics: 'evaluation metrics',
    data: 'Evaluation metric data',
  },
  feedback: {
    metric: 'feedback metric',
    metrics: 'feedback metrics',
    data: 'Feedback data',
  },
}

/**
 * @param {string[]} metricTypes
 * @returns {string} the quoted list, e.g. `"categorical", "score" or "json"`
 */
function formatMetricTypes (metricTypes) {
  const quoted = metricTypes.map(metricType => `"${metricType}"`)
  return `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1)}`
}

// Built once at load time: only ever used to build an error message.
/** @type {Record<MetricEventKind, string>} */
const METRIC_TYPES_MESSAGE = {
  evaluation: formatMetricTypes(EVALUATION_METRIC_TYPES),
  feedback: formatMetricTypes(FEEDBACK_METRIC_TYPES),
}

/**
 * Builds an error carrying the telemetry error tag the SDK reports for the failed submission.
 * @param {string} errorTag - Telemetry `error_type` tag value.
 * @param {string} message - User-facing message.
 * @returns {Error} the tagged error, to be thrown by the caller.
 */
function taggedError (errorTag, message) {
  const error = new Error(message)
  // Same shape as the tagger's failures, which the SDK already reads back as `e.ddErrorTag`.
  Object.defineProperty(error, 'ddErrorTag', { get () { return errorTag } })
  return error
}

/**
 * @param {unknown} timestampMs
 * @param {MetricEventKind} kind
 * @returns {void}
 */
function validateTimestamp (timestampMs, kind) {
  if (typeof timestampMs !== 'number' || timestampMs < 0) {
    throw taggedError(
      'invalid_timestamp',
      `timestampMs must be a non-negative integer. ${TERMS[kind].data} will not be sent`
    )
  }
}

/**
 * @param {string | undefined} label
 * @param {MetricEventKind} kind
 * @returns {void}
 */
function validateLabel (label, kind) {
  if (!label) {
    throw taggedError('invalid_metric_label', `label must be the specified name of the ${TERMS[kind].metric}`)
  }

  // A dot makes the label unusable as a facet key on the feedback side. `submitEvaluation` has
  // always accepted dotted labels, so the check stays scoped to feedback to avoid a breaking change.
  if (kind === 'feedback' && typeof label === 'string' && label.includes('.')) {
    throw taggedError('invalid_label_value', 'label value must not contain a "."')
  }
}

/**
 * @param {string | undefined} metricType - Already lower-cased metric type.
 * @param {MetricEventKind} kind
 * @returns {void}
 */
function validateMetricType (metricType, kind) {
  if (!metricType || !METRIC_TYPES[kind].includes(metricType)) {
    throw taggedError('invalid_metric_type', `metricType must be one of ${METRIC_TYPES_MESSAGE[kind]}`)
  }
}

/**
 * @param {string | undefined} metricType - Metric type already validated for the submitted kind.
 * @param {unknown} value
 * @returns {void}
 */
function validateMetricValue (metricType, value) {
  if (metricType === 'categorical' && typeof value !== 'string') {
    throw taggedError('invalid_metric_value', 'value must be a string for a categorical metric.')
  }
  if (metricType === 'score' && typeof value !== 'number') {
    throw taggedError('invalid_metric_value', 'value must be a number for a score metric.')
  }
  if (metricType === 'boolean' && typeof value !== 'boolean') {
    throw taggedError('invalid_metric_value', 'value must be a boolean for a boolean metric')
  }
  if (metricType === 'json' && (typeof value !== 'object' || value == null || Array.isArray(value))) {
    throw taggedError('invalid_metric_value', 'value must be a JSON object for a json metric')
  }
  if (metricType === 'text' && typeof value !== 'string') {
    throw taggedError('invalid_metric_value', 'value must be a string for a text metric')
  }
}

/**
 * @param {unknown} assessment
 * @returns {void}
 */
function validateAssessment (assessment) {
  if (assessment != null && assessment !== 'pass' && assessment !== 'fail') {
    throw taggedError('invalid_assessment', 'assessment must be pass or fail')
  }
}

/**
 * @param {unknown} reasoning
 * @returns {void}
 */
function validateReasoning (reasoning) {
  if (reasoning != null && typeof reasoning !== 'string') {
    throw taggedError('invalid_reasoning', 'reasoning must be a string')
  }
}

/**
 * Serializes the user-provided tags into the `key:value` list expected by the intake, along
 * with the tags every submission carries.
 * @param {Record<string, MetricTagValue> | undefined} tags - User-provided tags, coerced when not strings.
 * @param {string} mlApp - Resolved ML app name.
 * @param {MetricEventKind} kind
 * @param {boolean} [otelEnabled] - Adds `source:otel` so the backend waits for OTel span conversion.
 * @returns {string[]} the serialized tag list.
 */
function buildMetricTags (tags, mlApp, kind, otelEnabled = false) {
  const metricTags = {
    'ddtrace.version': tracerVersion,
    ml_app: mlApp,
  }

  if (tags) {
    for (const key in tags) {
      const tag = tags[key]
      if (typeof tag === 'string') {
        metricTags[key] = tag
      } else if (typeof tag.toString === 'function') {
        metricTags[key] = tag.toString()
      } else if (tag == null) {
        metricTags[key] = Object.prototype.toString.call(tag)
      } else {
        // should be a rare case
        // every object in JS has a toString, otherwise every primitive has its own toString
        // null and undefined are handled above
        throw taggedError('invalid_tags', `Failed to parse tags. Tags for ${TERMS[kind].metrics} must be strings`)
      }
    }
  }

  if (otelEnabled) {
    metricTags.source = 'otel'
  }

  return Object.entries(metricTags).map(([key, value]) => `${key}:${value}`)
}

module.exports = {
  EVALUATION_METRIC_TYPES,
  FEEDBACK_METRIC_TYPES,
  FEEDBACK_TARGET_KEYS,
  buildMetricTags,
  validateAssessment,
  validateLabel,
  validateMetricType,
  validateMetricValue,
  validateReasoning,
  validateTimestamp,
}
