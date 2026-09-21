'use strict'

const { types: { isDate, isProxy } } = require('node:util')

const { normalizeTargetingKey } = require('./flag-evaluation-pii')

const MAX_CONTEXT_FIELDS = 256
const MAX_KEY_LENGTH = 256
const MAX_VALUE_LENGTH = 256
const MAX_LIST_ELEMENTS = 256
const MAX_STRUCTURE_PROPERTIES = 256
const MAX_SNAPSHOT_DEPTH = 4
const MAX_VISITED_NODES = MAX_CONTEXT_FIELDS * (MAX_SNAPSHOT_DEPTH + 1)

/** @typedef {string | number | boolean | null} ContextScalar */
/** @typedef {Readonly<Record<string, ContextScalar>>} ContextSnapshot */
/**
 * @typedef {object} Frame
 * @property {object} container
 * @property {string} prefix
 * @property {number} depth
 * @property {string[] | undefined} keys
 * @property {number} index
 * @property {number} limit
 */

/**
 * Only plain data records are supported; caller-defined behavior is not part of telemetry.
 * Check proxies before any reflection, including revoked proxies.
 *
 * @param {unknown} value
 */
function isRecord (value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/**
 * Retain only a capped set of property names, in JavaScript's natural key order.
 *
 * Object.keys must enumerate the complete object: JS has no bounded own-key API.
 * The key-list allocation is proportional to object width, unlike indexed array
 * traversal. Explicit traversal, frame retention, and output are independently capped.
 *
 * @param {object} container
 * @param {string} prefix
 * @param {number} depth
 * @param {Set<string>} reasons
 * @returns {Frame}
 */
function createFrame (container, prefix, depth, reasons) {
  let keys
  let limit
  if (Array.isArray(container)) {
    limit = Math.min(container.length, MAX_LIST_ELEMENTS)
    if (container.length > limit) reasons.add('max_list_elements')
  } else {
    const allKeys = Object.keys(container)
    if (depth === -1) {
      const excluded = Object.getOwnPropertyDescriptor(container, 'targetingKey')?.enumerable === true
      if (allKeys.length - Number(excluded) > MAX_STRUCTURE_PROPERTIES) reasons.add('max_context_fields')
      keys = allKeys.slice(0, MAX_STRUCTURE_PROPERTIES + 1)
        .filter(key => key !== 'targetingKey').slice(0, MAX_STRUCTURE_PROPERTIES)
    } else {
      if (allKeys.length > MAX_STRUCTURE_PROPERTIES) reasons.add('max_structure_properties')
      keys = allKeys.slice(0, MAX_STRUCTURE_PROPERTIES)
    }
    limit = keys.length
  }
  return { container, prefix, depth, keys, index: 0, limit }
}

/**
 * Flatten consented context into a frozen, scalar-only snapshot before enqueue.
 * No getters, proxy traps, iterators, or caller serialization hooks are invoked.
 * The caller must check capacity and consent before calling this function.
 *
 * @param {unknown} context - Caller-owned OpenFeature context
 * @returns {{ attrs: ContextSnapshot, reasons: Set<string> }}
 */
function snapshotEvaluationContext (context) {
  /** @type {Record<string, ContextScalar>} */
  const attrs = Object.create(null)
  const reasons = new Set()
  if (!isRecord(context)) {
    if (context !== null && context !== undefined) reasons.add('unsupported_type')
    return { attrs: Object.freeze(attrs), reasons }
  }

  const root = /** @type {object} */ (context)
  const ancestors = new WeakSet([root])
  const stack = [createFrame(root, '', -1, reasons)]
  let visited = 0
  let fields = 0

  while (stack.length > 0) {
    const frame = /** @type {Frame} */ (stack.at(-1))
    if (frame.index === frame.limit) {
      ancestors.delete(frame.container)
      stack.pop()
      continue
    }
    if (fields === MAX_CONTEXT_FIELDS) {
      reasons.add('max_context_fields')
      break
    }
    if (visited === MAX_VISITED_NODES) {
      reasons.add('max_visited_nodes')
      break
    }
    visited++
    const key = frame.keys ? frame.keys[frame.index++] : String(frame.index++)
    const prefix = frame.depth === -1 ? key : frame.prefix + '.' + key
    if (prefix.length > MAX_KEY_LENGTH) {
      reasons.add('max_key_length')
      continue
    }
    if (normalizeTargetingKey(prefix) === undefined) {
      reasons.add('invalid_encoding')
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(frame.container, key)
    if (!descriptor?.enumerable) continue
    if (!Object.hasOwn(descriptor, 'value')) {
      reasons.add('unsupported_type')
      continue
    }
    /** @type {unknown} */
    let value = descriptor.value
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_LENGTH) {
        reasons.add('max_value_length')
        continue
      }
      if (normalizeTargetingKey(value) === undefined) {
        reasons.add('invalid_encoding')
        continue
      }
    } else if (value !== null && typeof value === 'object') {
      if (isProxy(value)) {
        reasons.add('unsupported_type')
        continue
      }
      if (isDate(value)) {
        if (!Number.isFinite(Date.prototype.getTime.call(value))) {
          reasons.add('unsupported_type')
          continue
        }
        value = Date.prototype.toISOString.call(value)
      } else {
        if (!Array.isArray(value) && !isRecord(value)) {
          reasons.add('unsupported_type')
          continue
        }
        const depth = frame.depth + 1
        if (depth >= MAX_SNAPSHOT_DEPTH) {
          reasons.add('max_snapshot_depth')
          continue
        }
        if (ancestors.has(value)) {
          reasons.add('cycle')
          continue
        }
        ancestors.add(value)
        stack.push(createFrame(value, prefix, depth, reasons))
        continue
      }
    } else if (value !== null && typeof value !== 'boolean' &&
               (typeof value !== 'number' || !Number.isFinite(value))) {
      reasons.add('unsupported_type')
      continue
    }

    if (!Object.hasOwn(attrs, prefix)) fields++
    attrs[prefix] = /** @type {ContextScalar} */ (value)
  }

  return { attrs: Object.freeze(attrs), reasons }
}

/**
 * Key only the bounded serialized snapshot, after queue handoff.
 * JSON tuples preserve scalar types and escape delimiters; sorting at most 256
 * keys makes equivalent retained contexts identical regardless of insertion order.
 * JSON-equivalent numbers such as -0 and 0 deliberately share an identity.
 *
 * @param {ContextSnapshot} attrs - Output of snapshotEvaluationContext, never caller-owned context
 */
function canonicalContextKey (attrs) {
  return JSON.stringify(Object.keys(attrs).sort().map(key => [key, attrs[key]]))
}

module.exports = { snapshotEvaluationContext, canonicalContextKey }
