'use strict'

const tracerVersion = require('../../../../package.json').version

/**
 * Kind of event submitted through the evaluation metrics intake. Both kinds share the
 * writer, the endpoint and most of their validation, and are told apart on the wire by
 * the `event_kind` field.
 * @typedef {'evaluation' | 'feedback'} MetricEventKind
 */

/**
 * Tag value the intake accepts: a string, a nullish value, or anything the SDK can coerce
 * through `toString()`.
 * @typedef {string | null | undefined | { toString?: unknown }} MetricTagValue
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
 * @param {MetricEventKind} kind
 * @returns {Error} the tagged error, to be thrown by the caller.
 */
function invalidTagsError (kind) {
  return taggedError('invalid_tags', `Failed to parse tags. Tags for ${TERMS[kind].metrics} must be strings`)
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
 * Validates the label and returns it as sent on the wire.
 * @param {unknown} label
 * @param {MetricEventKind} kind
 * @returns {unknown} the label, coerced to a string for feedback and left untouched for evaluations.
 */
function validateLabel (label, kind) {
  if (!label) {
    throw taggedError('invalid_metric_label', `label must be the specified name of the ${TERMS[kind].metric}`)
  }

  // Evaluations keep the looser check they shipped with: a dotted or non-string label reaches the
  // intake as-is. Aligning them with feedback rejects calls that succeed today, so it is deferred.
  if (kind === 'evaluation') return label

  // A dot makes the label unusable as a facet key.
  const labelValue = String(label)
  if (labelValue.includes('.')) {
    throw taggedError('invalid_label_value', 'label value must not contain a "."')
  }

  return labelValue
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
  // An array or a string would otherwise be walked by index and produce tags named after
  // their offsets, which the intake would happily store.
  if (tags != null && (typeof tags !== 'object' || Array.isArray(tags))) {
    throw invalidTagsError(kind)
  }

  const metricTags = {
    'ddtrace.version': tracerVersion,
    ml_app: mlApp,
  }

  if (tags) {
    for (const key of Object.keys(tags)) {
      const tag = tags[key]
      if (typeof tag === 'string') {
        metricTags[key] = tag
      } else if (tag == null) {
        // A nullish value can be intentional, so it is serialized rather than rejected. Checked
        // before the `toString` lookup below, which would throw a raw TypeError on it.
        metricTags[key] = String(tag)
      } else if (typeof tag.toString === 'function') {
        metricTags[key] = tag.toString()
      } else {
        // Every other value carries a `toString`, either its own or the one inherited from
        // `Object.prototype`, so this is only reached for a null-prototype object.
        throw invalidTagsError(kind)
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
