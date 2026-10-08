'use strict'

const { Stream } = require('node:stream')
const { isDataView, isDate, isMap, isSet } = require('node:util').types

const { maxValueLength, truncated } = require('./constants')

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

// Captured native DataView brand check: observes only the [[DataView]]
// internal slot, so it identifies genuine DataViews in any realm without the
// realm-sensitive `instanceof` and without consulting payload-defined
// properties. DataView.prototype[Symbol.toStringTag] is a data property rather
// than an accessor, so it cannot be used as a brand check.
const getDataViewByteLength = getterOf(DataView.prototype, 'byteLength')
const getDataViewByteOffset = getterOf(DataView.prototype, 'byteOffset')
const getDataViewBuffer = getterOf(DataView.prototype, 'buffer')

// Opaque leaves must also be isolated from downstream JSONPath mutations.
// Native brands and metadata operations avoid cross-realm instanceof checks
// and payload-defined constructors, conversion hooks, getters, and iterators.
const getDateTime = Date.prototype.getTime
const getMapSize = getterOf(Map.prototype, 'size')
const getSetSize = getterOf(Set.prototype, 'size')

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
// carries. A typed array or DataView that does not fit in the remaining budget
// is replaced with the `truncated` sentinel; an over-budget Buffer keeps its
// rendered prefix when that prefix still fits.
const maxBinaryCopyBytes = 1_000_000

// Buffers render as their UTF-8 decoding cut to `maxValueLength` code units.
// Each code unit consumes at most three bytes (a malformed sequence decodes to
// one U+FFFD per maximal subpart of up to three bytes), so the first
// `maxValueLength * 3` bytes always decode to the rendered units; four extra
// bytes are a defensive margin. A prefix of this size therefore renders the
// same tag value as the full Buffer.
const maxBufferPrefixBytes = maxValueLength * 3 + 4

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
 * an unsupported kind. Brand detection never consults payload-defined
 * properties and never throws, which keeps it separate from metadata
 * validation: `visibleByteLength` reads view metadata and may throw for
 * detached storage, propagating that error to the fail-soft boundary.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @returns {string | null} 'buffer', 'DataView', or a trusted typed-array kind
 */
function binaryKind (value) {
  if (Buffer.isBuffer(value)) {
    return 'buffer'
  }
  if (isDataView(value)) {
    return 'DataView'
  }
  const kind = /** @type {string} */ (getTypedArrayKind?.call(value))
  return typedArrayConstructors.has(kind) ? kind : null
}

/**
 * Read the visible byte length of a genuine Buffer or ArrayBuffer view using
 * only intrinsic getters. Never consults payload-defined metadata properties.
 * Unlike brand detection, this validation reads view metadata and the DataView
 * getter throws for detached storage; the error propagates unchanged to
 * computeTags' fail-soft boundary.
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
 * from the same trusted source used for budget admission. Native construction
 * of the source view rejects detached ArrayBuffers for every visible byte
 * length, including zero, without consulting backing-buffer constructors or
 * species; that error reaches computeTags' fail-soft boundary.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @param {string} kind trusted kind from `binaryKind`
 * @param {number} byteLength number of leading visible bytes to copy, at most the trusted
 *   visible byte length from `visibleByteLength`
 * @returns {Buffer | TypedArray | DataView}
 */
function copyBinary (value, kind, byteLength) {
  if (kind === 'buffer') {
    // Build a trusted source view over the intrinsic backing range, including
    // for zero-byte views, and copy from it, so Buffer construction cannot
    // consult spoofed source properties. Native construction rejects detached
    // storage instead of consulting backing-buffer constructors or species.
    const source = new Uint8Array(
      /** @type {ArrayBuffer} */ (getTypedArrayBuffer?.call(value)),
      /** @type {number} */ (getTypedArrayByteOffset?.call(value)),
      byteLength
    )
    const copy = Buffer.alloc(byteLength)
    copy.set(source)
    return copy
  }
  if (kind === 'DataView') {
    const source = new Uint8Array(
      /** @type {ArrayBuffer} */ (getDataViewBuffer?.call(value)),
      /** @type {number} */ (getDataViewByteOffset?.call(value)),
      byteLength
    )
    const bytes = new Uint8Array(byteLength)
    bytes.set(source)
    return new DataView(bytes.buffer)
  }
  const TypedArray = /** @type {TypedArrayConstructor} */ (typedArrayConstructors.get(kind))
  // Copy the visible bytes through a trusted Uint8Array source view, including
  // for zero-byte views, then wrap the fresh buffer in the payload value's
  // native kind. All steps stay on native code paths, so payload-defined hooks
  // are never consulted, and detached storage is rejected by construction.
  const source = new Uint8Array(
    /** @type {ArrayBuffer} */ (getTypedArrayBuffer?.call(value)),
    /** @type {number} */ (getTypedArrayByteOffset?.call(value)),
    byteLength
  )
  const bytes = new Uint8Array(byteLength)
  bytes.set(source)
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
 * - Dates, Maps and Sets become isolated native leaves without attached
 *   properties. Dates retain their time value; collection entries are not
 *   traversed. Nonempty collections mark the snapshot incomplete so predicates
 *   cannot silently change redaction decisions after their contents are omitted.
 * - Buffers and ArrayBuffer views are copied into fresh storage within the
 *   binary budget so path-based redaction cannot mutate caller-owned bytes.
 *   An over-budget Buffer keeps only the prefix its string tag renders.
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
      if (byteLength === null) {
        state.incomplete = true
        assign(container, key, truncated, root)
        return
      }
      let copyLength = byteLength
      if (byteLength > state.binaryBudget) {
        // An over-budget Buffer keeps the prefix its string tag renders. The
        // shortened copy changes data such as its length, so the snapshot is
        // marked incomplete and data-dependent rules stay suppressed. Typed
        // arrays render one tag per element and are never shortened.
        copyLength = kind === 'buffer' ? Math.min(byteLength, maxBufferPrefixBytes) : byteLength
        state.incomplete = true
        if (copyLength > state.binaryBudget) {
          assign(container, key, truncated, root)
          return
        }
      }
      state.binaryBudget -= copyLength
      assign(container, key, copyBinary(view, /** @type {string} */ (kind), copyLength), root)
      return
    }

    if (isDate(value)) {
      assign(container, key, new Date(getDateTime.call(value)), root)
      return
    }
    if (isMap(value)) {
      if (getMapSize?.call(value) !== 0) state.incomplete = true
      assign(container, key, new Map(), root)
      return
    }
    if (isSet(value)) {
      if (getSetSize?.call(value) !== 0) state.incomplete = true
      assign(container, key, new Set(), root)
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
