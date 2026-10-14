'use strict'

const { Stream } = require('node:stream')
const { isDataView, isDate, isMap, isSet } = require('node:util').types

const { maxValueLength, truncated } = require('./constants')

// Intrinsics captured once at module load and invoked directly on payload
// values, so overridden `slice` methods, custom `Symbol.species`, or spoofed
// metadata such as `byteLength` can neither mutate caller bytes nor bypass
// the copy budget. Hardening covers payload-controlled behavior only;
// replacement of global intrinsics before module load is out of scope.

/**
 * @param {object} object
 * @param {string | symbol} key
 * @returns {Function | undefined} the own accessor getter, if any
 */
function getterOf (object, key) {
  return Object.getOwnPropertyDescriptor(object, key)?.get
}

// Typed-array metadata getters inherited from %TypedArray%.prototype; calling
// them directly bypasses payload-spoofed own properties.
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype)
const getTypedArrayKind = getterOf(typedArrayProto, Symbol.toStringTag)
const getTypedArrayByteLength = getterOf(typedArrayProto, 'byteLength')
const getTypedArrayByteOffset = getterOf(typedArrayProto, 'byteOffset')
const getTypedArrayBuffer = getterOf(typedArrayProto, 'buffer')

// Intrinsic DataView metadata getters, used only after the isDataView brand
// check; they avoid realm-sensitive instanceof and payload-defined properties.
// DataView.prototype[Symbol.toStringTag] is a data property, not a getter, so
// it cannot serve as a brand check.
const getDataViewByteLength = getterOf(DataView.prototype, 'byteLength')
const getDataViewByteOffset = getterOf(DataView.prototype, 'byteOffset')
const getDataViewBuffer = getterOf(DataView.prototype, 'buffer')

// Native brands and metadata for opaque leaves avoid cross-realm instanceof
// and payload-defined constructors, conversion hooks, getters, and iterators.
const getDateTime = Date.prototype.getTime
// Available in Node 18, despite the experimental label on older LTS lines.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const webStreamPrototype = globalThis.ReadableStream?.prototype
const getStreamLocked = webStreamPrototype && getterOf(webStreamPrototype, 'locked')
const maxStreamPrototypeDepth = 100

/**
 * A trusted native typed-array constructor, usable with `new`.
 *
 * @typedef {typeof Int8Array | typeof Uint8Array | typeof Uint8ClampedArray |
 *   typeof Int16Array | typeof Uint16Array | typeof Int32Array | typeof Uint32Array |
 *   typeof Float32Array | typeof Float64Array | typeof BigInt64Array | typeof BigUint64Array}
 *   TypedArrayConstructor
 */

// Trusted native constructors for wrapping fresh copies in the value's
// element kind; payload-defined subclasses and species are never consulted.
const typedArrayConstructors = new Map(/** @type {Array<[string, TypedArrayConstructor]>} */ ([
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
]))
// Only set when the runtime exposes it, keeping the module loadable elsewhere.
if (typeof globalThis.Float16Array === 'function') {
  typedArrayConstructors.set(
    'Float16Array', /** @type {TypedArrayConstructor} */ (/** @type {unknown} */ (globalThis.Float16Array))
  )
}

// Independent of the configured output max depth: capture must stay bounded.
const maxDepth = 100
const maxEntries = 10_000
const maxArrayLength = 10_000

// Aggregate byte budget for binary copies shared by every `createSafeSnapshot`
// call given the same budget. Copying keeps later JSONPath redaction from
// mutating application-owned bytes; over-budget views become `truncated`,
// except a Buffer that keeps its rendered prefix.
const maxBinaryCopyBytes = 1_000_000

// A Buffer's tag renders its UTF-8 decoding cut to `maxValueLength` code
// units. Each code unit consumes at most 3 bytes (malformed sequences decode
// to one U+FFFD per maximal subpart), so a prefix of this size plus a small
// margin renders the same tag value as the full Buffer.
const maxBufferPrefixBytes = maxValueLength * 3 + 4

/**
 * Typed-array views over an ArrayBuffer, excluding Buffers and DataViews.
 *
 * @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array |
 *   Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array} TypedArray
 */

/**
 * Detect native streams and descriptor-backed getReader functions without
 * executing payload accessors. Streams are never enumerated, cloned, drained,
 * or locked: consuming one would corrupt the application's own use of the
 * payload.
 *
 * @param {object} value
 */
function isStream (value) {
  // Inspect effective descriptors without executing accessors; the walk is
  // bounded rather than an unbounded instanceof through a controlled chain.
  let current = value
  let descriptor
  for (let depth = 0; current !== null && depth < maxStreamPrototypeDepth; depth++) {
    if (current === Stream.prototype || current === webStreamPrototype) return true
    descriptor ??= Object.getOwnPropertyDescriptor(current, 'getReader')
    if (typeof descriptor?.value === 'function') return true
    current = Object.getPrototypeOf(current)
  }
  // An exhausted inspection bound is ambiguous, so truncate conservatively.
  if (current !== null) return true
  if (descriptor && getStreamLocked) {
    // A foreign stream may shadow getReader; check the native brand instead.
    try {
      getStreamLocked.call(value)
      return true
    } catch {
      return false
    }
  }
  return false
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
 * property so the snapshot cannot mutate prototypes.
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
 * Identify a genuine Buffer or ArrayBuffer view using only intrinsic brand
 * checks, returning `null` for unsupported kinds. Never consults
 * payload-defined properties and never throws.
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
 * Read the visible byte length using only intrinsic getters. May throw for
 * detached storage; the caller truncates only that leaf.
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
 * Copy a Buffer or ArrayBuffer view into fresh writable storage so later
 * redaction cannot mutate application-owned bytes. Only the visible byte
 * range is copied; the element type is preserved so tag formats stay stable
 * (Buffers keep their string tag, typed arrays their per-index tags).
 *
 * Uses only the intrinsics captured at module load; `kind` and `byteLength`
 * must come from the same trusted source used for budget admission. Native
 * construction rejects detached storage, including zero-byte views, without
 * consulting payload hooks; the caller truncates only that leaf.
 *
 * @param {Buffer | TypedArray | DataView} value
 * @param {string} kind trusted kind from `binaryKind`
 * @param {number} byteLength number of leading visible bytes to copy, at most the trusted
 *   visible byte length from `visibleByteLength`
 * @returns {Buffer | TypedArray | DataView}
 */
function copyBinary (value, kind, byteLength) {
  const getBuffer = kind === 'DataView' ? getDataViewBuffer : getTypedArrayBuffer
  const getByteOffset = kind === 'DataView' ? getDataViewByteOffset : getTypedArrayByteOffset
  // Native construction validates even zero-byte views without payload hooks.
  const source = new Uint8Array(
    /** @type {ArrayBuffer} */ (getBuffer?.call(value)),
    /** @type {number} */ (getByteOffset?.call(value)),
    byteLength
  )
  const bytes = kind === 'buffer' ? Buffer.alloc(byteLength) : new Uint8Array(byteLength)
  bytes.set(source)

  if (kind === 'buffer') {
    return bytes
  }
  if (kind === 'DataView') {
    return new DataView(bytes.buffer)
  }
  const TypedArray = /** @type {TypedArrayConstructor} */ (typedArrayConstructors.get(kind))
  return new TypedArray(bytes.buffer)
}

/**
 * One container whose children are still being captured. Values are read only
 * when their work is admitted against the entry budget; frames are bounded by
 * the depth limit, since each nested container adds exactly one.
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
 * Remaining snapshot work: admitted entries and binary copy bytes.
 *
 * @typedef {{ entries: number, binaryBytes: number }} SnapshotBudget
 */

/**
 * @returns {SnapshotBudget} a full budget for one payload
 */
function createSnapshotBudget () {
  return { entries: maxEntries, binaryBytes: maxBinaryCopyBytes }
}

/**
 * Produce a bounded, acyclic, stream-safe snapshot of an arbitrary payload.
 *
 * - Streams and cyclic back-references become `truncated` without being read.
 * - Depth, admitted entries and aggregate binary copy bytes are bounded;
 *   over-limit values become `truncated` and mark the snapshot incomplete.
 * - Dates, Maps and Sets become isolated native leaves without attached
 *   properties. Their data is never inspected or rendered, so they always
 *   mark the snapshot incomplete and predicates cannot silently change
 *   redaction or expansion decisions after their data is omitted.
 * - Buffers and ArrayBuffer views are copied into fresh storage within the
 *   binary budget so redaction cannot mutate caller-owned bytes. An
 *   over-budget Buffer keeps the prefix its string tag renders. Normalization
 *   always drops metadata the tag format cannot carry (view offsets, backing
 *   storage, prototypes, shadowed properties), so every binary value marks
 *   the capture incomplete instead of proving the loss harmless.
 * - Repeated non-circular references are copied per occurrence so redaction
 *   rules keep matching each path independently.
 * - Own enumerable string-keyed properties of plain objects and class
 *   instances are captured; getters are read at most once, and only when
 *   admitted.
 *
 * The root and every admitted descendant each count one entry against
 * `maxEntries`; once exhausted, traversal stops without reading or
 * materializing anything else and the snapshot is marked incomplete. Passing
 * the same `budget` to several calls bounds their combined work.
 *
 * Known limitation: `Object.keys` still enumerates one entry per own key of
 * every expanded container; JavaScript offers no lazy own-key enumeration
 * primitive compatible with the repository's `for-in` prohibition. The
 * avoidable work (value reads, getter side effects, copied entries, pending
 * frames, tag growth) is bounded by `maxEntries`.
 *
 * @param {unknown} input
 * @param {SnapshotBudget} [budget] remaining work, consumed in place
 * @returns {{ value: unknown, incomplete: boolean }}
 */
function createSafeSnapshot (input, budget = createSnapshotBudget()) {
  let incomplete = false
  const root = { value: undefined }
  /** @type {Frame[]} */
  const stack = []

  /**
   * Copy a genuine Buffer or ArrayBuffer view within the binary budget, or
   * return `truncated` for unsupported or over-budget views. Throws for
   * detached storage; the budget is debited only after a successful copy.
   *
   * @param {Buffer | TypedArray | DataView} view
   * @returns {Buffer | TypedArray | DataView | string}
   */
  function captureBinary (view) {
    const kind = binaryKind(view)
    if (kind === null) {
      incomplete = true
      return truncated
    }
    const byteLength = visibleByteLength(view, kind)
    let copyLength = byteLength
    if (byteLength > budget.binaryBytes) {
      // The over-budget Buffer keeps the prefix its tag renders; the changed
      // length marks the snapshot incomplete. Typed arrays are never shortened.
      copyLength = kind === 'buffer' ? Math.min(byteLength, maxBufferPrefixBytes) : byteLength
      if (copyLength > budget.binaryBytes) {
        incomplete = true
        return truncated
      }
    }
    const copy = copyBinary(view, kind, copyLength)
    // Normalization always changes or drops metadata the tag format cannot
    // carry (view offsets, backing storage, prototypes, shadowed properties).
    // Rather than prove the loss harmless, mark every binary value incomplete
    // so data-dependent rules cannot decide redaction from the copy.
    incomplete = true
    budget.binaryBytes -= copyLength
    return copy
  }

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
      let copy
      try {
        copy = captureBinary(/** @type {Buffer | TypedArray | DataView} */ (value))
      } catch {
        // Native reads reject detached storage; only this leaf is lost. Never
        // inspect the caught value.
        incomplete = true
        copy = truncated
      }
      assign(container, key, copy, root)
      return
    }

    // Opaque leaves render no payload tags, so anything they hold is lost:
    // marking the snapshot incomplete keeps predicates from silently changing
    // redaction or expansion decisions after that data is omitted, without
    // reading getters or iterating contents.
    if (isDate(value)) {
      incomplete = true
      assign(container, key, new Date(getDateTime.call(value)), root)
      return
    }
    if (isMap(value)) {
      incomplete = true
      assign(container, key, new Map(), root)
      return
    }
    if (isSet(value)) {
      incomplete = true
      assign(container, key, new Set(), root)
      return
    }

    if (
      // Reject omitted work before even inspecting stream descriptors.
      hasAncestor(ancestors, value) ||
      depth >= maxDepth ||
      (Array.isArray(value) && value.length > maxArrayLength) ||
      isStream(value)
    ) {
      incomplete = true
      assign(container, key, truncated, root)
      return
    }

    const copy = Array.isArray(value) ? [] : {}
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
  if (budget.entries <= 0) {
    return { value: truncated, incomplete: true }
  }
  budget.entries--
  admit(null, null, input, 0, null)

  while (stack.length > 0) {
    // eslint-disable-next-line unicorn/prefer-at
    const frame = stack[stack.length - 1]

    if (frame.index === frame.keys.length) {
      stack.pop()
      continue
    }

    if (budget.entries <= 0) {
      // Budget exhausted: stop without reading or materializing anything else.
      incomplete = true
      break
    }

    const key = frame.keys[frame.index]
    frame.index++
    budget.entries--
    // Read only once admitted, so getter side effects cannot grow with
    // omitted siblings.
    admit(frame.copy, key, frame.source[key], frame.childDepth, frame.ancestors)
  }

  return { value: root.value, incomplete }
}

module.exports = { createSafeSnapshot, createSnapshotBudget }
