'use strict'

const IGNORED_FIELDS = [
  'trace_id',
  'span_id',
  'parent_id',
  'start_ns',
  'duration',
  'language',
  'version',
  'runtime_id',
  'hostname',
  'service',
  'env',
  'ddtrace.version',
  'source',
]

function normalizeTag (tag) {
  if (typeof tag !== 'string') return tag
  const separator = tag.indexOf(':')
  if (separator === -1 || !IGNORED_FIELDS.includes(tag.slice(0, separator))) return tag
  return `${tag.slice(0, separator)}:<ignored>`
}

function normalizeTags (tags) {
  if (Array.isArray(tags)) return tags.map(normalizeTag).sort()
  if (!tags || typeof tags !== 'object') return tags
  return Object.fromEntries(Object.entries(tags)
    .map(([key, value]) => [key, IGNORED_FIELDS.includes(key) ? '<ignored>' : value])
    .sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeSpans (spans) {
  const ordered = [...spans].sort((left, right) => (left.start_ns ?? 0) - (right.start_ns ?? 0))
  const spanOrdinals = new Map()
  ordered.forEach((span, index) => span.span_id !== undefined && spanOrdinals.set(String(span.span_id), index))
  const traceRoots = new Map()
  for (const span of ordered) {
    const traceId = String(span.trace_id ?? '')
    if (!traceRoots.has(traceId)) traceRoots.set(traceId, spanOrdinals.get(String(span.span_id)) ?? 0)
  }

  return ordered.map(span => {
    const normalized = JSON.parse(JSON.stringify(span))
    normalized.trace_id = traceRoots.get(String(span.trace_id ?? '')) ?? 0
    normalized.span_id = spanOrdinals.get(String(span.span_id)) ?? 0
    normalized.parent_id = span.parent_id === undefined || span.parent_id === null
      ? null
      : (spanOrdinals.get(String(span.parent_id)) ?? span.parent_id)
    delete normalized.start_ns
    delete normalized.duration
    normalized.tags = normalizeTags(normalized.tags)
    return normalized
  })
}

function normalizeCapture (capture) {
  return {
    sdk_version: capture.sdk_version,
    spans: normalizeSpans(capture.spans ?? []),
  }
}

module.exports = { IGNORED_FIELDS, normalizeCapture, normalizeSpans }
