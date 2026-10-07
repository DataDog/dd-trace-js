'use strict'

const { Stream } = require('node:stream')

// Snapshot limits are independent of the configured output max depth: payload
// capture must stay bounded no matter how deep the caller asks tags to go.
const maxDepth = 100
const maxEntries = 10_000
const maxArrayLength = 10_000

const truncated = 'truncated'

/**
 * Detect Node.js streams and web ReadableStreams. Streams are never
 * enumerated, cloned, drained, or otherwise touched: their internals hold
 * circular references (sockets, parsers, readable state), and consuming them
 * would corrupt the application's own use of the payload.
 *
 * @param {object} value
 */
function isStream (value) {
  if (value instanceof Stream) {
    return true
  }
  // Duck-type web ReadableStreams. A plain object exposing getReader is
  // treated as a stream as well: truncating a stream-like value is safe,
  // whereas enumerating an unknown exotic object is not.
  return typeof value.getReader === 'function'
}

/**
 * One node of a singly linked list holding the containers between the value
 * currently being visited and the root. Chains are shared between siblings of
 * the same container, so membership checks cost at most the snapshot depth.
 *
 * @typedef {{ value: object, next: Ancestors | null }} Ancestors
 */

/**
 * @param {Ancestors | null} ancestors
 * @param {object} value
 */
function hasAncestor (ancestors, value) {
  for (let node = ancestors; node !== null; node = node.next) {
    if (node.value === value) {
      return true
    }
  }
  return false
}

/**
 * Assign `value` to `container[key]`, keeping `__proto__` a plain data
 * property so hostile payloads cannot mutate prototypes through the snapshot
 * copy.
 *
 * @param {Record<string, unknown> | unknown[] | null} container
 * @param {string | null} key
 * @param {unknown} value
 * @param {{ value: unknown }} root
 */
function assign (container, key, value, root) {
  if (container === null) {
    root.value = value
    return
  }
  if (key === '__proto__') {
    Object.defineProperty(container, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  container[key] = value
}

/**
 * Produce a bounded, acyclic, stream-safe snapshot of an arbitrary payload.
 *
 * - Streams become `truncated` without being read.
 * - Cyclic back-references become `truncated`.
 * - Traversal depth and total visited entries are bounded; over-limit branches
 *   become `truncated` and mark the snapshot incomplete.
 * - The input is never mutated or retained. Scalars, Buffers, Dates, Maps and
 *   Sets are carried by reference because payload tagging only reads them.
 * - Repeated non-circular references are copied per occurrence so path-based
 *   redaction rules keep matching each path independently.
 * - Own enumerable string-keyed properties of plain objects and class
 *   instances are captured, matching the surface the previous deep clone
 *   walked; getters are read exactly once during capture.
 *
 * @param {unknown} input
 * @returns {{ value: unknown, incomplete: boolean }}
 */
function createSafeSnapshot (input) {
  const state = { incomplete: false, visited: 0 }
  const root = { value: undefined }
  // Each frame holds the container and key the value belongs to, its depth,
  // and the chain of containers between it and the root. An explicit stack
  // keeps traversal immune to unbounded payload depth.
  const stack = [{ container: null, key: null, value: input, depth: 0, ancestors: null }]

  while (stack.length > 0) {
    const { container, key, value, depth, ancestors } = stack.pop()

    if (state.visited >= maxEntries) {
      // Budget exhausted: stop reading values and truncate what remains
      // without retaining captured siblings' progress.
      state.incomplete = true
      assign(container, key, truncated, root)
      continue
    }
    state.visited++

    if (value === null || typeof value !== 'object') {
      assign(container, key, value, root)
      continue
    }

    if (
      Buffer.isBuffer(value) || ArrayBuffer.isView(value) ||
      value instanceof Date || value instanceof Map || value instanceof Set
    ) {
      assign(container, key, value, root)
      continue
    }

    if (
      isStream(value) ||
      hasAncestor(ancestors, value) ||
      depth >= maxDepth ||
      (Array.isArray(value) && value.length > maxArrayLength)
    ) {
      state.incomplete = true
      assign(container, key, truncated, root)
      continue
    }

    const copy = Array.isArray(value) ? [] : Object.create(null)
    assign(container, key, copy, root)

    // All children share one ancestor chain node.
    const childAncestors = { value, next: ancestors }
    const keys = Object.keys(value)
    // Push in reverse so frames pop in original key order.
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push({
        container: copy,
        key: keys[i],
        value: value[keys[i]],
        depth: depth + 1,
        ancestors: childAncestors,
      })
    }
  }

  return { value: root.value, incomplete: state.incomplete }
}

module.exports = { createSafeSnapshot, truncated }
