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

// TODO (bengl) Pretty much everything in this file should happen in
// `format.js`, so that we're not iterating over all the spans and modifying
// them yet again.

// normally the agent truncates the resource and parses it in certain scenarios (e.g. SQL Queries)
function truncateSpan (span, shouldTruncateResourceName = true) {
  if (shouldTruncateResourceName && span.resource && span.resource.length > MAX_RESOURCE_NAME_LENGTH) {
    span.resource = `${span.resource.slice(0, MAX_RESOURCE_NAME_LENGTH)}...`
  }
  for (let metaKey in span.meta) {
    const val = span.meta[metaKey]
    if (metaKey.length > MAX_META_KEY_LENGTH) {
      delete span.meta[metaKey]
      metaKey = `${metaKey.slice(0, MAX_META_KEY_LENGTH)}...`
      span.metrics[metaKey] = val
    }
    if (val && val.length > MAX_META_VALUE_LENGTH) {
      span.meta[metaKey] = `${val.slice(0, MAX_META_VALUE_LENGTH)}...`
    }
  }
  for (let metricsKey in span.metrics) {
    const val = span.metrics[metricsKey]
    if (metricsKey.length > MAX_METRIC_KEY_LENGTH) {
      delete span.metrics[metricsKey]
      metricsKey = `${metricsKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`
      span.metrics[metricsKey] = val
    }
  }

  return span
}

function normalizeSpan (span) {
  span.service = span.service || DEFAULT_SERVICE_NAME
  if (span.service.length > MAX_SERVICE_LENGTH) {
    span.service = span.service.slice(0, MAX_SERVICE_LENGTH)
  }
  span.name = span.name || DEFAULT_SPAN_NAME
  if (span.name.length > MAX_NAME_LENGTH) {
    span.name = span.name.slice(0, MAX_NAME_LENGTH)
  }
  if (!span.resource) {
    span.resource = span.name
  }
  if (span.type && span.type.length > MAX_TYPE_LENGTH) {
    span.type = span.type.slice(0, MAX_TYPE_LENGTH)
  }

  return span
}

module.exports = {
  truncateSpan,
  normalizeSpan,
  MAX_META_KEY_LENGTH,
  MAX_META_VALUE_LENGTH,
  MAX_METRIC_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SERVICE_LENGTH,
  MAX_TYPE_LENGTH,
  MAX_RESOURCE_NAME_LENGTH,
  DEFAULT_SPAN_NAME,
  DEFAULT_SERVICE_NAME
}
