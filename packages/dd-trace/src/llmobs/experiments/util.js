'use strict'

const { randomUUID } = require('node:crypto')

const log = require('../../log')

// Matches the backend and dd-trace-py evaluator metric label contract.
const EVALUATOR_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * @typedef {null | string | number | boolean | NormalizedJsonValue[] | { [key: string]: NormalizedJsonValue }}
 *   NormalizedJsonValue
 */

/**
 * @param {object | null | undefined} value
 * @returns {boolean}
 */
function hasEntries (value) {
  if (!value) return false
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(value, key)) return true
  }
  return false
}

function validateTagsList (tags) {
  if (tags == null) return []
  if (!Array.isArray(tags)) throw new TypeError('Tags must be an array of strings')
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new TypeError('Each tag must be a string')
    if (tag.indexOf(':') <= 0) {
      throw new Error(`Tag '${tag}' is malformed. Tags must be in 'key:value' format (e.g., 'env:prod').`)
    }
  }
  return [...tags]
}

function tagOperationsAreEmpty (operations) {
  return operations == null || (
    !Object.hasOwn(operations, 'replace') &&
    !Object.hasOwn(operations, 'add') &&
    !Object.hasOwn(operations, 'remove')
  )
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function normalizePositiveInteger (value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

/**
 * @returns {string}
 */
function generateRunId () {
  return randomUUID()
}

/**
 * @param {string} name
 */
function validateEvaluatorName (name) {
  if (typeof name !== 'string') throw new TypeError('Evaluator name must be a string')
  if (name.length === 0) throw new Error('Evaluator name cannot be empty')
  if (!EVALUATOR_NAME_PATTERN.test(name)) {
    throw new Error(
      `Evaluator name '${name}' is invalid. Name must contain only alphanumeric characters, underscores, and hyphens.`
    )
  }
}

/**
 * @param {(...args: unknown[]) => unknown} fn
 * @param {string} fallback
 * @returns {string}
 */
function functionName (fn, fallback) {
  return typeof fn.name === 'string' && fn.name.length > 0 ? fn.name : fallback
}

/**
 * @param {unknown} evaluators
 * @param {string} kind
 * @returns {Array<[string, (...args: unknown[]) => unknown]>}
 */
function normalizeEvaluators (evaluators, kind) {
  if (evaluators == null) return []

  const normalized = []
  if (Array.isArray(evaluators)) {
    const indexesByName = new Map()
    for (let i = 0; i < evaluators.length; i++) {
      const evaluator = evaluators[i]
      if (typeof evaluator !== 'function') throw new TypeError(`${kind} evaluator must be a function`)
      const name = functionName(evaluator, `${kind}_evaluator_${i}`)
      validateEvaluatorName(name)
      if (indexesByName.has(name)) {
        log.warn('Duplicate %s evaluator name %s; previous evaluator will be overwritten', kind, name)
        normalized[indexesByName.get(name)] = [name, evaluator]
      } else {
        indexesByName.set(name, normalized.length)
        normalized.push([name, evaluator])
      }
    }
    return normalized
  }

  if (typeof evaluators !== 'object') {
    throw new TypeError(`${kind} evaluators must be an array of functions or an object keyed by evaluator name`)
  }

  for (const [name, evaluator] of Object.entries(evaluators)) {
    validateEvaluatorName(name)
    if (typeof evaluator !== 'function') throw new TypeError(`${kind} evaluator '${name}' must be a function`)
    normalized.push([name, evaluator])
  }
  return normalized
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function inferMetricType (value) {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return 'score'
  if (typeof value === 'string') return 'categorical'
  return 'json'
}

/**
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @returns {NormalizedJsonValue}
 */
function normalizeJsonValue (value, seen) {
  if (value === null) return null

  const valueType = typeof value
  if (valueType === 'string' || valueType === 'boolean') return value
  if (valueType === 'number') return Number.isFinite(value) ? value : String(value)
  if (valueType === 'bigint') return value.toString()
  if (valueType === 'undefined') return null
  if (valueType === 'symbol') return value.toString()
  if (valueType === 'function') return { type: 'function', name: value.name || '<anonymous>' }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack ?? '' }
  }

  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const normalized = new Array(value.length)
    for (let i = 0; i < value.length; i++) normalized[i] = normalizeJsonValue(value[i], seen)
    seen.delete(value)
    return normalized
  }

  const normalized = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    normalized[key] = normalizeJsonValue(nestedValue, seen)
  }
  seen.delete(value)
  return normalized
}

/**
 * @param {unknown} value
 * @returns {{ [key: string]: NormalizedJsonValue }}
 */
function normalizeJsonMetricValue (value) {
  const normalized = normalizeJsonValue(value, new WeakSet())
  if (normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)) return normalized
  return { value: normalized }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify (value) {
  if (value == null) return ''
  if (typeof value === 'string') return value.toLowerCase()
  if (typeof value === 'object') {
    try {
      const stringified = JSON.stringify(value)
      if (stringified !== undefined) return stringified.toLowerCase()
    } catch {}
  }
  return String(value).toLowerCase()
}

/**
 * @param {Record<string, unknown> | undefined} userTags
 * @param {Record<string, unknown>} autoTags
 * @returns {string[]}
 */
function buildTags (userTags, autoTags) {
  const tagsByKey = new Map()
  if ((userTags) != null) {
    for (const [key, value] of Object.entries(userTags)) {
      const values = Array.isArray(value) ? value : [value]
      tagsByKey.set(key, values.map(item => `${key}:${item}`))
    }
  }
  for (const [key, value] of Object.entries(autoTags)) {
    if (value !== undefined && value !== null && value !== '') tagsByKey.set(key, [`${key}:${value}`])
  }

  const tags = []
  for (const values of tagsByKey.values()) tags.push(...values)
  return tags
}

/**
 * @param {Record<string, unknown> | undefined} baseTags
 * @param {Record<string, unknown> | undefined} overrideTags
 * @returns {Record<string, unknown>}
 */
function mergeTags (baseTags, overrideTags) {
  return { ...baseTags, ...overrideTags }
}

/**
 * @param {string[] | undefined} tags
 * @returns {Record<string, string | string[]>}
 */
function recordTagsToObject (tags) {
  const result = {}
  if (!Array.isArray(tags)) return result
  for (const tag of tags) {
    const separator = tag.indexOf(':')
    if (separator <= 0) continue

    const key = tag.slice(0, separator)
    const value = tag.slice(separator + 1)
    if (!Object.hasOwn(result, key)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
    } else if (Array.isArray(result[key])) {
      result[key].push(value)
    } else {
      result[key] = [result[key], value]
    }
  }
  return result
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep (ms) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function timestampMs (value, fallback = Date.now()) {
  if (value === null || value === undefined) return fallback
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : fallback
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * @param {{ durationMs?: unknown, completedAt?: unknown }} row
 * @param {number} startMs
 * @returns {number}
 */
function durationNs (row, startMs) {
  if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) {
    return Math.max(0, Math.round(row.durationMs * 1e6))
  }

  if (row.completedAt !== undefined) {
    const completedMs = timestampMs(row.completedAt, startMs)
    return Math.max(0, Math.round((completedMs - startMs) * 1e6))
  }

  return 0
}

/**
 * @param {Record<string, unknown> | undefined} recordMetadata
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown>}
 */
function buildSpanMetadata (recordMetadata, config) {
  return recordMetadata
    ? { ...recordMetadata, experiment_config: config }
    : { experiment_config: config }
}

module.exports = {
  buildSpanMetadata,
  buildTags,
  durationNs,
  generateRunId,
  hasEntries,
  inferMetricType,
  mergeTags,
  normalizeEvaluators,
  normalizeJsonMetricValue,
  normalizePositiveInteger,
  recordTagsToObject,
  sleep,
  stringify,
  tagOperationsAreEmpty,
  timestampMs,
  validateEvaluatorName,
  validateTagsList,
}
