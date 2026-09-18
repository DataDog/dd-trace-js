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

const IGNORED_TAG_KEYS = new Set([...IGNORED_FIELDS, 'git.commit.sha', 'git.repository_url'])

function normalizeTag (tag) {
  if (typeof tag !== 'string') return tag
  const separator = tag.indexOf(':')
  return separator === -1 || !IGNORED_TAG_KEYS.has(tag.slice(0, separator)) ? tag : undefined
}

function normalizeTags (tags) {
  if (Array.isArray(tags)) return tags.map(normalizeTag).filter(tag => tag !== undefined).sort()
  if (!tags || typeof tags !== 'object') return tags
  return Object.fromEntries(Object.entries(tags)
    .filter(([key]) => !IGNORED_TAG_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeMeta (meta) {
  const normalized = { ...meta }
  for (const [key, value] of Object.entries(meta)) {
    if (!key.includes('.')) continue
    delete normalized[key]
    const parts = key.split('.')
    let target = normalized
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {}
      target = target[part]
    }
    target[parts.at(-1)] = value
  }
  return normalized
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
    if (normalized._dd) {
      delete normalized._dd.trace_id
      delete normalized._dd.span_id
      delete normalized._dd.apm_trace_id
    }
    if (normalized.meta) normalized.meta = normalizeMeta(normalized.meta)
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
