'use strict'

const EVENT_TYPES = new Set(['test', 'test_module_end', 'test_session_end', 'test_suite_end'])
const META_FIELDS = new Set([
  'test.command',
  'test.early_flake.enabled',
  'test.final_status',
  'test.is_new',
  'test.is_retry',
  'test.module',
  'test.name',
  'test.retry_reason',
  'test.source.file',
  'test.status',
  'test.suite',
  'test.test_management.attempt_to_fix_passed',
  'test.test_management.enabled',
  'test.test_management.is_attempt_to_fix',
  'test.test_management.is_quarantined',
  'test.test_management.is_test_disabled',
])
const METRIC_FIELDS = new Set(['test.is_new', 'test.is_retry'])

/**
 * Projects a decoded Test Optimization payload into the fixed validation-only event schema.
 *
 * @param {unknown} payload decoded Test Optimization payload
 * @returns {{events: object[], version: 1}} allowlisted payload
 */
function projectTestCyclePayload (payload) {
  if (!isObject(payload) || payload.version !== 1 || !Array.isArray(payload.events)) {
    throw new Error('Test Optimization validation payload has an unsupported envelope.')
  }

  const events = []
  for (const event of payload.events) {
    if (isNonTestSpan(event)) continue
    events.push(projectEvent(event))
  }
  return { version: 1, events }
}

/**
 * Projects coverage into bounded linkage fields without persisting source paths or bitmaps.
 *
 * @param {unknown} payload coverage payload
 * @returns {object[]} projected coverage records
 */
function projectCoveragePayload (payload) {
  const records = Array.isArray(payload) ? payload : [payload]
  return records.map(record => {
    if (!isObject(record)) throw new Error('Test Optimization validation coverage has an unsupported shape.')
    const projected = {}
    copyScalar(projected, record, 'test_session_id')
    copyScalar(projected, record, 'test_suite_id')
    if (Array.isArray(record.files)) projected.fileCount = record.files.length
    return projected
  })
}

function projectEvent (event) {
  if (!isObject(event) || !EVENT_TYPES.has(event.type) || !isObject(event.content)) {
    throw new Error('Test Optimization validation payload contains an unsupported event shape.')
  }

  return {
    type: event.type,
    content: {
      meta: projectFields(event.content.meta, META_FIELDS),
      metrics: projectFields(event.content.metrics, METRIC_FIELDS),
    },
  }
}

function isNonTestSpan (event) {
  if (!isObject(event) || event.type !== 'span') return false
  if (!isObject(event.content)) {
    throw new Error('Test Optimization validation payload contains an unsupported span shape.')
  }
  return true
}

function projectFields (source, allowed) {
  const projected = {}
  if (!isObject(source)) return projected
  for (const name of allowed) copyScalar(projected, source, name)
  return projected
}

function copyScalar (target, source, name) {
  const value = source[name]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') target[name] = value
}

function isObject (value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

module.exports = {
  EVENT_TYPES,
  projectCoveragePayload,
  projectTestCyclePayload,
}
