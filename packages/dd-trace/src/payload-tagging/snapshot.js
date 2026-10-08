'use strict'

const { Stream } = require('node:stream')

const { truncated } = require('./constants')

// Payload-controlled objects must not be able to influence how their binary
// values are copied, identified, or measured: an overridden `slice`, a custom
// `Symbol.species`, or a spoofed `byteLength` could otherwise mutate caller
// bytes or bypass the copy budget. Everything below is captured once at module
// initialization from this realm's intrinsics and invoked directly on the
// payload value, so payload-defined methods, constructors, species, and
// metadata properties are never consulted. Defending against arbitrary
// replacement of the global intrinsics themselves before module load is out of
// scope: only payload-controlled object behavior is hardened here.

/**
 * @param {object} object
 * @param {string | symbol} key
 * @returns {Function | undefined} the own accessor getter, if any
 */
function getterOf (object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor?.get
}

// The element-kind, byteLength, byteOffset and buffer getters live on
// `%TypedArray%.prototype`, which every typed array (including Buffers and
// subclasses) inherits. Calling them directly yields intrinsic metadata even
// when the payload defines own spoofed properties.
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype)
const getTypedArrayKind = getterOf(typedArrayProto, Symbol.toStringTag)
const getTypedArrayByteLength = getterOf(typedArrayProto, 'byteLength')
const getTypedArrayByteOffset = getterOf(typedArrayProto, 'byteOffset')
const getTypedArrayBuffer = getterOf(typedArrayProto, 'buffer')

// Native ArrayBuffer.prototype.slice reads through the backing storage and
// throws for a detached buffer, which makes it a non-destructive detachment
// probe. SharedArrayBuffer storage needs its own slice method.
const arrayBufferSlice = ArrayBuffer.prototype.slice
const sharedArrayBufferSlice = typeof SharedArrayBuffer === 'function'
  ? SharedArrayBuffer.prototype.slice
  : null

/**
 * Throw when `buffer` is detached. A zero-byte view over a detached buffer is
 * indistinguishable from a genuine empty view through intrinsic metadata, and
 * constructing it does not throw, so the backing buffer is read through its
 * native slice instead. This preserves the previous fail-soft behavior of
 * copying through `TypedArray.prototype.slice`, which read the source bytes.
 * A cross-realm SharedArrayBuffer reaches the non-shared slice and throws; the
 * fail-soft boundary absorbs the error.
 *
 * @param {ArrayBuffer} buffer
 */
function assertBufferNotDetached (buffer) {
  if (sharedArrayBufferSlice && buffer instanceof SharedArrayBuffer) {
    sharedArrayBufferSlice.call(buffer, 0, 0)
    return
  }
  arrayBufferSlice.call(buffer, 0, 0)
}

// A brand check: the DataView byteLength getter throws for typed arrays and
// other non-DataView receivers, so it identifies genuine DataViews without the
// realm-sensitive `instanceof`. DataView.prototype[Symbol.toStringTag] is a
// data property rather than an accessor, so it cannot be used as a brand check.
const getDataViewByteLength = getterOf(DataView.prototype, 'byteLength')
const getDataViewByteOffset = getterOf(DataView.prototype, 'byteOffset')
const getDataViewBuffer = getterOf(DataView.prototype, 'buffer')

/**
 * A trusted native typed-array constructor, usable with `new`.
 *
 * @typedef {typeof Int8Array | typeof Uint8Array | typeof Uint8ClampedArray |
 *   typeof Int16Array | typeof Uint16Array | typeof Int32Array | typeof Uint32Array |
 *   typeof Float32Array | typeof Float64Array | typeof BigInt64Array | typeof BigUint64Array}
 *   TypedArrayConstructor
 */

// Closed map of trusted native constructors, used to wrap fresh copies in the
// payload value's native element kind. Payload-defined subclasses and species
// are never consulted, so a payload cannot choose the copy's type or storage.
const typedArrayEntries = /** @type {Array<[string, TypedArrayConstructor]>} */ ([
  ['Int8Array', Int8Array],
  ['Uint8Array', Uint8Array],
  ['Uint8ClampedArray', Uint8ClampedArray],
  ['Int16Array', Int16Array],
  ['Uint16Array', Uint16Array],
  ['Int32Array', Int32Array],
  ['Uint32Array', Uint32Array],
  ['Float32Array', Float32Array],
  ['Float64Array', Float64Array],
  ['BigInt64Array', BigInt64Array],
  ['BigUint64Array', BigUint64Array],
])
const typedArrayConstructors = new Map(typedArrayEntries)
// Optional numeric format: only added when the runtime exposes it, keeping the
// module loadable on runtimes without this typed array.
if (typeof globalThis.Float16Array === 'function') {
  typedArrayConstructors.set(
    'Float16Array', /** @type {TypedArrayConstructor} */ (/** @type {unknown} */ (globalThis.Float16Array))
  )
}

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
 * Identify a genuine Buffer or ArrayBuffer view by its native kind using only
 * intrinsic brand checks, returning `null` when the value is a genuine view of
 * an unsupported kind. Never consults payload-defined properties.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @returns {string | null} 'buffer', 'DataView', or a trusted typed-array kind
 */
function binaryKind (value) {
  if (Buffer.isBuffer(value)) {
    return 'buffer'
  }
  try {
    // The DataView byteLength getter requires the [[DataView]] internal slot
    // and throws for typed arrays, which fall through to the kind getter.
    getDataViewByteLength?.call(value)
    return 'DataView'
  } catch {}
  const kind = /** @type {string} */ (getTypedArrayKind?.call(value))
  return typedArrayConstructors.has(kind) ? kind : null
}

/**
 * Read the visible byte length of a genuine Buffer or ArrayBuffer view using
 * only intrinsic getters. Never consults payload-defined metadata properties.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @param {string} kind trusted kind from `binaryKind`
 */
function visibleByteLength (value, kind) {
  if (kind === 'DataView') {
    return /** @type {number} */ (getDataViewByteLength?.call(value))
  }
  return /** @type {number} */ (getTypedArrayByteLength?.call(value))
}

/**
 * Copy a Buffer or ArrayBuffer view into fresh writable storage so that later
 * redaction of the snapshot can never mutate application-owned bytes. Only the
 * view's visible byte range is copied, never its entire backing buffer. The
 * element type is preserved so existing tag formats stay stable: Buffers keep
 * their string tag and typed arrays keep their per-index tags.
 *
 * Copying relies solely on the intrinsics captured at module initialization:
 * payload-defined methods, constructors, species, `Symbol.toStringTag`, and
 * metadata properties are never consulted. `kind` and `byteLength` must come
 * from the same trusted source used for budget admission. Copy failures,
 * including detached buffers, reach computeTags' fail-soft boundary.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @param {string} kind trusted kind from `binaryKind`
 * @param {number} byteLength trusted visible byte length from `visibleByteLength`
 * @returns {Buffer | TypedArray | DataView}
 */
function copyBinary (value, kind, byteLength) {
  if (kind === 'buffer') {
    // Build a trusted byte view over the intrinsic backing range and copy from
    // it, so Buffer construction cannot consult spoofed source properties.
    const sourceBuffer = /** @type {ArrayBuffer} */ (getTypedArrayBuffer?.call(value))
    if (byteLength === 0) assertBufferNotDetached(sourceBuffer)
    const source = new Uint8Array(
      sourceBuffer,
      /** @type {number} */ (getTypedArrayByteOffset?.call(value)),
      byteLength
    )
    const copy = Buffer.alloc(byteLength)
    copy.set(source)
    return copy
  }
  if (kind === 'DataView') {
    const buffer = /** @type {ArrayBuffer} */ (getDataViewBuffer?.call(value))
    const byteOffset = /** @type {number} */ (getDataViewByteOffset?.call(value))
    const bytes = new Uint8Array(byteLength)
    if (byteLength > 0) {
      bytes.set(new Uint8Array(buffer, byteOffset, byteLength))
    }
    return new DataView(bytes.buffer)
  }
  const TypedArray = /** @type {TypedArrayConstructor} */ (typedArrayConstructors.get(kind))
  // Copy the visible bytes through a trusted Uint8Array view, then wrap the
  // fresh buffer in the payload value's native kind. All steps stay on native
  // code paths, so payload-defined hooks are never consulted.
  const buffer = /** @type {ArrayBuffer} */ (getTypedArrayBuffer?.call(value))
  if (byteLength === 0) assertBufferNotDetached(buffer)
  const byteOffset = /** @type {number} */ (getTypedArrayByteOffset?.call(value))
  const bytes = new Uint8Array(byteLength)
  if (byteLength > 0) {
    bytes.set(new Uint8Array(buffer, byteOffset, byteLength))
  }
  return new TypedArray(bytes.buffer)
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
      const view = /** @type {Buffer | TypedArray | DataView} */ (value)
      const kind = binaryKind(view)
      const byteLength = kind === null ? null : visibleByteLength(view, kind)
      // Unsupported genuine views are truncated like over-budget ones, and an
      // unexpectedly thrown error (for example a detached buffer) still reaches
      // computeTags' fail-soft boundary unchanged.
      if (byteLength === null || byteLength > state.binaryBudget) {
        state.incomplete = true
        assign(container, key, truncated, root)
        return
      }
      state.binaryBudget -= byteLength
      assign(container, key, copyBinary(view, /** @type {string} */ (kind), byteLength), root)
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
