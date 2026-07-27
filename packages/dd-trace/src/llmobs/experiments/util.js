'use strict'

const log = require('../../log')

// Matches the backend and dd-trace-py evaluator metric label contract.
const EVALUATOR_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject (value) {
  return Object.prototype.toString.call(value) === '[object Object]'
}

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

  if (!isPlainObject(evaluators)) {
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
  if (isPlainObject(value)) return 'json'
  return 'categorical'
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringify (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.toLowerCase()
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase()
  return String(value).toLowerCase()
}

/**
 * @param {Record<string, unknown> | undefined} userTags
 * @param {Record<string, unknown>} autoTags
 * @returns {string[]}
 */
function buildTags (userTags, autoTags) {
  const tags = new Map()
  for (const [key, value] of Object.entries(userTags ?? {})) {
    tags.set(key, `${key}:${value}`)
  }
  for (const [key, value] of Object.entries(autoTags)) {
    if (value !== undefined && value !== null && value !== '') tags.set(key, `${key}:${value}`)
  }
  return [...tags.values()]
}

/**
 * @param {Record<string, unknown> | undefined} userTags
 * @param {Record<string, unknown>} autoTags
 * @returns {Record<string, unknown>}
 */
function buildExperimentTagObject (userTags, autoTags) {
  return userTags ? { ...userTags, ...autoTags } : { ...autoTags }
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
  buildExperimentTagObject,
  buildSpanMetadata,
  buildTags,
  hasEntries,
  inferMetricType,
  isPlainObject,
  normalizeEvaluators,
  sleep,
  stringify,
  validateEvaluatorName,
}
