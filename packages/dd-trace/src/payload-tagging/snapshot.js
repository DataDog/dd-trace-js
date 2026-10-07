'use strict'

const { Stream } = require('node:stream')

const { truncated } = require('./constants')

// Snapshot limits are independent of the configured output max depth: payload
// capture must stay bounded no matter how deep the caller asks tags to go.
const maxDepth = 100
const maxEntries = 10_000
const maxArrayLength = 10_000

// Aggregate budget for copies of binary values (Buffers and typed-array views)
// across a single `createSafeSnapshot` invocation. Copying keeps later
// JSONPath redaction from mutating application-owned bytes; the shared budget
// keeps the total copy work bounded no matter how many binary values a payload
// carries. A value that does not fit in the remaining budget is replaced with
// the `truncated` sentinel instead of being partially copied.
const maxBinaryCopyBytes = 1_000_000

/**
 * Typed-array views over an ArrayBuffer, excluding Buffers and DataViews.
 *
 * @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array |
 *   Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array} TypedArray
 */

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
 * Copy a Buffer or ArrayBuffer view into fresh writable storage so that later
 * redaction of the snapshot can never mutate application-owned bytes. Only the
 * view's visible byte range is copied, never its entire backing buffer. The
 * element type is preserved so existing tag formats stay stable: Buffers keep
 * their string tag and typed arrays keep their per-index tags.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @returns {Buffer | TypedArray | DataView}
 */
function copyBinary (value) {
  if (Buffer.isBuffer(value)) {
    // Buffer.from copies the bytes; Buffer.prototype.slice would share them.
    return Buffer.from(value)
  }
  if (value instanceof DataView) {
    const bytes = new Uint8Array(value.byteLength)
    if (value.byteLength > 0) {
      bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    }
    return new DataView(bytes.buffer)
  }
  // %TypedArray%.prototype.slice copies the visible range into a new buffer of
  // the same type. A spread would produce a plain array and lose the element
  // type. Copy failures, including detached buffers, reach computeTags' fail-soft
  // boundary.
  // eslint-disable-next-line unicorn/prefer-spread
  return value.slice()
}

/**
 * One container whose children are still being captured. The frame owns a
 * cursor over the source container's own keys, so values are read (and getters
 * run) only when their work is admitted against the entry budget; siblings
 * beyond the budget are never read. Pending frames are bounded by the depth
 * limit because each nested container adds exactly one frame.
 *
 * @typedef {{
 *   source: object,
 *   copy: Record<string, unknown> | unknown[],
 *   keys: string[],
 *   index: number,
 *   childDepth: number,
 *   ancestors: Ancestors | null
 * }} Frame
 */

/**
 * Produce a bounded, acyclic, stream-safe snapshot of an arbitrary payload.
 *
 * - Streams become `truncated` without being read.
 * - Cyclic back-references become `truncated`.
 * - Traversal depth, total admitted values, and aggregate binary copy bytes
 *   are bounded; over-limit values become `truncated` and mark the snapshot
 *   incomplete.
 * - Scalars, Dates, Maps and Sets are carried by reference because payload
 *   tagging only reads them. Buffers and ArrayBuffer views are copied into
 *   fresh storage within the binary budget so path-based redaction rules
 *   cannot mutate the application's own bytes.
 * - Repeated non-circular references are copied per occurrence so path-based
 *   redaction rules keep matching each path independently.
 * - Own enumerable string-keyed properties of plain objects and class
 *   instances are captured, matching the surface the previous deep clone
 *   walked; getters are read at most once, and only when admitted.
 *
 * Entry counting: the root and every admitted descendant each count as one
 * entry against `maxEntries`. Once the budget is exhausted, traversal stops
 * without reading or materializing anything else; the snapshot is marked
 * incomplete instead of allocating a placeholder per omitted property.
 *
 * Known limitation: `Object.keys` still enumerates and allocates one entry per
 * own key of every expanded container, so raw key enumeration grows with
 * container width. Standard JavaScript offers no lazy own-key enumeration
 * primitive that is compatible with the repository's prohibition on `for-in`.
 * The avoidable work (value reads, getter side effects, copied entries,
 * pending frames, and downstream tag growth) is bounded by `maxEntries`.
 *
 * @param {unknown} input
 * @returns {{ value: unknown, incomplete: boolean }}
 */
function createSafeSnapshot (input) {
  const state = {
    incomplete: false,
    visited: 0,
    binaryBudget: maxBinaryCopyBytes,
  }
  const root = { value: undefined }
  /** @type {Frame[]} */
  const stack = []

  /**
   * Store one admitted value in its destination container, pushing a frame
   * when the value is itself a container that can be expanded.
   *
   * @param {Record<string, unknown> | unknown[] | null} container
   * @param {string | null} key
   * @param {unknown} value
   * @param {number} depth
   * @param {Ancestors | null} ancestors
   */
  function admit (container, key, value, depth, ancestors) {
    if (value === null || typeof value !== 'object') {
      assign(container, key, value, root)
      return
    }

    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      if (value.byteLength > state.binaryBudget) {
        state.incomplete = true
        assign(container, key, truncated, root)
        return
      }
      state.binaryBudget -= value.byteLength
      assign(
        container, key,
        copyBinary(/** @type {Buffer | TypedArray | DataView} */ (value)), root
      )
      return
    }

    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      // Payload tagging only reads these leaves, so they are carried by
      // reference like the scalars above.
      assign(container, key, value, root)
      return
    }

    if (
      isStream(value) ||
      hasAncestor(ancestors, value) ||
      depth >= maxDepth ||
      (Array.isArray(value) && value.length > maxArrayLength)
    ) {
      state.incomplete = true
      assign(container, key, truncated, root)
      return
    }

    const copy = Array.isArray(value) ? [] : Object.create(null)
    assign(container, key, copy, root)
    stack.push({
      source: value,
      copy,
      keys: Object.keys(value),
      index: 0,
      childDepth: depth + 1,
      ancestors: { value, next: ancestors },
    })
  }

  // The root counts as one admitted entry like every other value.
  state.visited = 1
  admit(null, null, input, 0, null)

  while (stack.length > 0) {
    // eslint-disable-next-line unicorn/prefer-at
    const frame = stack[stack.length - 1]

    if (frame.index === frame.keys.length) {
      stack.pop()
      continue
    }

    if (state.visited >= maxEntries) {
      // Budget exhausted: stop reading values entirely. Remaining properties
      // are neither read nor materialized; the snapshot is marked incomplete.
      state.incomplete = true
      break
    }

    const key = frame.keys[frame.index]
    frame.index++
    state.visited++
    // The value is read only once its work is admitted, so getter side
    // effects cannot grow with omitted siblings.
    admit(frame.copy, key, frame.source[key], frame.childDepth, frame.ancestors)
  }

  return { value: root.value, incomplete: state.incomplete }
}

module.exports = { createSafeSnapshot }
