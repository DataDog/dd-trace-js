// From agent truncators: https://github.com/DataDog/datadog-agent/blob/main/pkg/trace/agent/truncator.go

// Values from: https://github.com/DataDog/datadog-agent/blob/main/pkg/trace/traceutil/truncate.go#L22-L27
// MAX_RESOURCE_NAME_LENGTH the maximum length a span resource can have
const MAX_RESOURCE_NAME_LENGTH = 5000
// MAX_META_KEY_LENGTH the maximum length of metadata key
const MAX_META_KEY_LENGTH = 200
// MAX_META_VALUE_LENGTH the maximum length of metadata value
const MAX_META_VALUE_LENGTH = 25000
// MAX_METRIC_KEY_LENGTH the maximum length of a metric name key
const MAX_METRIC_KEY_LENGTH = MAX_META_KEY_LENGTH

// From agent normalizer:
// https://github.com/DataDog/datadog-agent/blob/main/pkg/trace/traceutil/normalize.go
// DEFAULT_SPAN_NAME is the default name we assign a span if it's missing and we have no reasonable fallback
const DEFAULT_SPAN_NAME = 'unnamed_operation'
// DEFAULT_SERVICE_NAME is the default name we assign a service if it's missing and we have no reasonable fallback
const DEFAULT_SERVICE_NAME = 'unnamed-service'
// MAX_NAME_LENGTH the maximum length a name can have
const MAX_NAME_LENGTH = 100
// MAX_SERVICE_LENGTH the maximum length a service can have
const MAX_SERVICE_LENGTH = 100
// MAX_TYPE_LENGTH the maximum length a span type can have
const MAX_TYPE_LENGTH = 100

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

function truncateToLength (value, maxLength) {
  if (!value) {
    return value
  }
  if (value.length > maxLength) {
    return `${value.slice(0, maxLength)}...`
  }
  return value
}

function truncateSpan (span) {
  return fromEntries(Object.entries(span).map(([key, value]) => {
    switch (key) {
      case 'resource':
        return ['resource', truncateToLength(value, MAX_RESOURCE_NAME_LENGTH)]
      case 'meta':
        return ['meta', fromEntries(Object.entries(value).map(([metaKey, metaValue]) =>
          [truncateToLength(metaKey, MAX_META_KEY_LENGTH), truncateToLength(metaValue, MAX_META_VALUE_LENGTH)]
        ))]
      case 'metrics':
        return ['metrics', fromEntries(Object.entries(value).map(([metricsKey, metricsValue]) =>
          [truncateToLength(metricsKey, MAX_METRIC_KEY_LENGTH), metricsValue]
        ))]
      default:
        return [key, value]
    }
  }))
}

function normalizeSpan (span) {
  return fromEntries(Object.entries(span).map(([key, value]) => {
    switch (key) {
      case 'span_id':
      case 'trace_id':
      case 'parent_id':
        return [key, value.toString(10)]
      case 'service':
        if (!value) {
          return [key, DEFAULT_SERVICE_NAME]
        }
        if (value.length > MAX_SERVICE_LENGTH) {
          return [key, value.slice(0, MAX_SERVICE_LENGTH)]
        }
        break
      case 'name':
        if (!value) {
          return [key, DEFAULT_SPAN_NAME]
        }
        if (value.length > MAX_NAME_LENGTH) {
          return [key, value.slice(0, MAX_NAME_LENGTH)]
        }
        break
      case 'resource':
        if (!value) {
          return [key, span.name || DEFAULT_SPAN_NAME]
        }
        break
      case 'type':
        if (!value) {
          return [key, value]
        }
        if (value.length > MAX_TYPE_LENGTH) {
          return [key, value.slice(0, MAX_TYPE_LENGTH)]
        }
    }
    return [key, value]
  }))
}

module.exports = { truncateSpan, normalizeSpan }
