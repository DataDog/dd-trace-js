'use strict'

const { Stream } = require('node:stream')
const { isAnyArrayBuffer, isDataView, isDate, isMap, isSet } = require('node:util').types

// Intrinsic used to invoke accessor getters, so a payload-defined `call`
// property on a getter (data or accessor) is never consulted.
const { apply: reflectApply } = Reflect

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

/**
 * Whether the value has any own enumerable string-keyed property. This still
 * allocates the full keys array: without `for-in`, which the repository
 * prohibits, there is no lazy own-key enumeration. It is only called on opaque
 * leaves (Dates, Maps, Sets, DataViews), which rarely carry own keys.
 *
 * @param {object} object
 */
function hasOwnEnumerableKeys (object) {
  return Object.keys(object)[0] !== undefined
}

/**
 * Whether a genuine typed array or DataView carries own enumerable keys beyond
 * its element indexes. Index keys of a typed array are exactly its element
 * count, read from the trusted copy; a DataView has no index keys. Enumeration
 * is bounded by the binary copy budget the view was admitted against.
 *
 * @param {TypedArray | DataView} view
 * @param {TypedArray | DataView} copy fresh copy with the same element count
 */
function hasAttachedProperties (view, copy) {
  if (isDataView(copy)) {
    return hasOwnEnumerableKeys(view)
  }
  return Object.keys(view).length !== /** @type {TypedArray} */ (copy).length
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
// mutating application-owned bytes; over-budget views become `truncated`.
// Buffers only ever copy their rendered prefix.
const maxBinaryCopyBytes = 1_000_000

// A Buffer's tag renders its UTF-8 decoding cut to `maxValueLength` code
// units. Each code unit consumes at most 3 bytes (malformed sequences decode
// to one U+FFFD per maximal subpart), so a prefix of this size plus a small
// margin renders the same tag value as the full Buffer. Bytes past it never
// render, so Buffers are never copied beyond it.
const maxBufferPrefixBytes = maxValueLength * 3 + 4

/**
 * Typed-array views over an ArrayBuffer, excluding Buffers and DataViews.
 *
 * @typedef {Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array |
 *   Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array} TypedArray
 */

/**
 * Detect native streams, descriptor-backed getReader functions, and Node-style
 * userland streams (descriptor-backed `pipe` and `on` functions, as in
 * readable-stream, minipass or streamx, which do not inherit from Node's
 * Stream) without executing payload accessors. Streams are never enumerated,
 * cloned, drained, or locked: consuming one would corrupt the application's
 * own use of the payload, and their internal state can hold buffered chunks.
 *
 * @param {object} value
 */
function isStream (value) {
  // Inspect effective descriptors without executing accessors; the walk is
  // bounded rather than an unbounded instanceof through a controlled chain.
  // The first descriptor found for a key shadows any later one.
  let current = value
  let descriptor
  let pipe
  let on
  for (let depth = 0; current !== null && depth < maxStreamPrototypeDepth; depth++) {
    if (current === Stream.prototype || current === webStreamPrototype) return true
    descriptor ??= Object.getOwnPropertyDescriptor(current, 'getReader')
    if (typeof descriptor?.value === 'function') return true
    pipe ??= Object.getOwnPropertyDescriptor(current, 'pipe')
    on ??= Object.getOwnPropertyDescriptor(current, 'on')
    if (typeof pipe?.value === 'function' && typeof on?.value === 'function') return true
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
 * @typedef {{ value: object, next: Ancestors | undefined }} Ancestors
 */

/**
 * @param {Ancestors | undefined} ancestors
 * @param {object} value
 */
function hasAncestor (ancestors, value) {
  for (let node = ancestors; node !== undefined; node = node.next) {
    if (node.value === value) {
      return true
    }
  }
  return false
}

/**
 * Write `value` to `container[key]` as an ordinary data property, keeping
 * `__proto__` a plain data property so the snapshot cannot mutate prototypes.
 *
 * @param {Record<string, unknown> | unknown[]} container
 * @param {string | number} key
 * @param {unknown} value
 */
function defineDataProperty (container, key, value) {
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
 * Assign `value` to `container[key]`, or to the root when `container` is undefined,
 * keeping `__proto__` a plain data property so the snapshot cannot mutate
 * prototypes.
 *
 * @param {Record<string, unknown> | unknown[] | undefined} container
 * @param {string | undefined} key
 * @param {unknown} value
 * @param {{ value: unknown }} root
 */
function assign (container, key, value, root) {
  if (container === undefined) {
    root.value = value
    return
  }
  defineDataProperty(container, /** @type {string} */ (key), value)
}

/**
 * Identify a genuine Buffer or ArrayBuffer view using only intrinsic brand
 * checks: 'buffer', 'DataView', or a trusted typed-array kind, and `undefined`
 * for unsupported kinds. Never consults payload-defined properties and never
 * throws.
 *
 * @param {Buffer | TypedArray | DataView} value
 */
function binaryKind (value) {
  if (Buffer.isBuffer(value)) {
    return 'buffer'
  }
  if (isDataView(value)) {
    return 'DataView'
  }
  const kind = /** @type {string} */ (getTypedArrayKind?.call(value))
  return typedArrayConstructors.has(kind) ? kind : undefined
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
  // Every byte is overwritten below, so zero-filling would be wasted work. The
  // unpooled allocation keeps the copy's backing storage private to it.
  const bytes = kind === 'buffer' ? Buffer.allocUnsafeSlow(byteLength) : new Uint8Array(byteLength)
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
 *   ancestors: Ancestors | undefined,
 *   sourceLength: number | undefined
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
 * Mutable state of one `createSafeSnapshot` call: the captured root `value`,
 * the flags described there, pending frames, and the shared budget.
 *
 * @typedef {{
 *   value: unknown,
 *   incomplete: boolean,
 *   normalized: boolean,
 *   stack: Frame[],
 *   budget: SnapshotBudget
 * }} SnapshotState
 */

/**
 * Record lost rendered content; loss always implies normalization.
 *
 * @param {SnapshotState} state
 */
function markIncomplete (state) {
  state.incomplete = true
  state.normalized = true
}

/**
 * Copy a genuine Buffer or ArrayBuffer view within the binary budget, or
 * return `truncated` for unsupported or over-budget views. Throws for
 * detached storage; the budget is debited only after a successful copy.
 *
 * @param {SnapshotState} state
 * @param {Buffer | TypedArray | DataView} view
 * @returns {Buffer | TypedArray | DataView | string}
 */
function captureBinary (state, view) {
  // Normalization always changes or drops metadata the tag format cannot
  // carry (view offsets, backing storage, prototypes, shadowed properties).
  // Rather than prove the loss harmless, mark every binary value normalized
  // so data-dependent rules cannot decide redaction from the copy.
  state.normalized = true
  const kind = binaryKind(view)
  if (kind === undefined) {
    markIncomplete(state)
    return truncated
  }
  let copyLength = visibleByteLength(view, kind)
  if (kind === 'buffer') {
    // A Buffer keeps only the prefix its tag renders. Typed arrays render
    // one tag per element and are never shortened.
    copyLength = Math.min(copyLength, maxBufferPrefixBytes)
  }
  if (copyLength > state.budget.binaryBytes) {
    markIncomplete(state)
    return truncated
  }
  const copy = copyBinary(view, kind, copyLength)
  state.budget.binaryBytes -= copyLength
  if (kind !== 'buffer' && hasAttachedProperties(view, copy)) {
    // Non-Buffer views render their own enumerable keys as tags, and the
    // copy discards attached ones. Buffers render only their bytes.
    markIncomplete(state)
  }
  return copy
}

/**
 * Store one admitted value in its destination container, pushing a frame
 * when the value is itself a container that can be expanded.
 *
 * @param {SnapshotState} state
 * @param {Record<string, unknown> | unknown[] | undefined} container
 * @param {string | undefined} key
 * @param {unknown} value
 * @param {number} depth
 * @param {Ancestors} [ancestors] undefined for the root
 */
function admit (state, container, key, value, depth, ancestors) {
  // Functions are opaque references into caller state: retaining one keeps
  // its mutable identity and attached data reachable from the snapshot, so
  // later redaction or expansion could mutate application-owned objects
  // through it. Omit the leaf without invoking, enumerating, or copying
  // anything reachable from it. Tags never render function values, so the
  // omission loses nothing rendered and only normalizes the capture.
  if (typeof value === 'function') {
    state.normalized = true
    return
  }

  if (value === null || typeof value !== 'object') {
    assign(container, key, value, state)
    return
  }

  // Buffer.isBuffer is not redundant with the isView check: it walks the
  // prototype chain, so a hostile cyclic Proxy throws here and the capture
  // fails soft at the computeTags boundary (pinned by a regression test).
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    let copy
    try {
      copy = captureBinary(state, /** @type {Buffer | TypedArray | DataView} */ (value))
    } catch {
      // Native reads reject detached storage; only this leaf is lost. Never
      // inspect the caught value.
      markIncomplete(state)
      copy = truncated
    }
    assign(container, key, copy, state)
    return
  }

  // Map and Set contents never render as tags, but dropping them can flip
  // predicates (for example on `size`): marking the snapshot normalized
  // keeps data-dependent rules from silently changing redaction or
  // expansion decisions, without reading getters or iterating contents.
  // A Date keeps its time value in the native copy, so on its own it is
  // neither normalized nor incomplete. Own enumerable string-keyed
  // properties of any of these leaves render as tags and are discarded, so
  // they mark the snapshot incomplete.
  if (isDate(value)) {
    if (hasOwnEnumerableKeys(value)) {
      markIncomplete(state)
    }
    assign(container, key, new Date(getDateTime.call(value)), state)
    return
  }
  if (isMap(value) || isSet(value)) {
    if (hasOwnEnumerableKeys(value)) {
      markIncomplete(state)
    } else {
      state.normalized = true
    }
    assign(container, key, isMap(value) ? new Map() : new Set(), state)
    return
  }
  // Raw ArrayBuffer and SharedArrayBuffer storage renders no tags either, but
  // predicates can read its metadata (for example `byteLength`). Bytes are
  // never copied: an empty native buffer stands in for it.
  if (isAnyArrayBuffer(value)) {
    if (hasOwnEnumerableKeys(value)) {
      markIncomplete(state)
    } else {
      state.normalized = true
    }
    assign(container, key, new ArrayBuffer(0), state)
    return
  }

  const isArray = Array.isArray(value)
  const sourceLength = isArray ? value.length : undefined

  if (
    // Reject omitted work before even inspecting stream descriptors.
    hasAncestor(ancestors, value) ||
    depth >= maxDepth ||
    (sourceLength !== undefined && sourceLength > maxArrayLength) ||
    isStream(value)
  ) {
    markIncomplete(state)
    assign(container, key, truncated, state)
    return
  }

  const copy = isArray ? [] : {}
  assign(container, key, copy, state)
  state.stack.push({
    source: value,
    copy,
    keys: Object.keys(value),
    index: 0,
    childDepth: depth + 1,
    ancestors: { value, next: ancestors },
    sourceLength,
  })
}

/**
 * Produce a bounded, acyclic, stream-safe snapshot of an arbitrary payload.
 *
 * Two flags describe how the snapshot differs from the payload:
 * - `normalized`: anything differs at all, including metadata the tag format
 *   never renders. Data-dependent rules could decide differently on the copy,
 *   so callers suppress tags for such rules when this is set.
 * - `incomplete`: rendered content was lost, because a value became
 *   `truncated`, a key whose value would have rendered was omitted, or
 *   attached properties were discarded. This drives the public
 *   `_dd.payload_tags_incomplete` tag. It implies `normalized`.
 *
 * - Streams and cyclic back-references become `truncated` without being read.
 * - Depth, admitted entries and aggregate binary copy bytes are bounded;
 *   over-limit values become `truncated` and mark the snapshot incomplete.
 * - Dates, Maps and Sets become isolated native leaves without attached
 *   properties. Map and Set contents are never inspected or rendered, so they
 *   mark the snapshot normalized and predicates cannot silently change
 *   redaction or expansion decisions after their data is omitted. A Date keeps
 *   its time value and is only flagged when it carries attached properties.
 *   Attached properties render as tags, so discarding them marks the snapshot
 *   incomplete.
 * - Buffers and ArrayBuffer views are copied into fresh storage within the
 *   binary budget so redaction cannot mutate caller-owned bytes. An
 *   over-budget Buffer keeps the prefix its string tag renders. Normalization
 *   always drops metadata the tag format cannot carry (view offsets, backing
 *   storage, prototypes, shadowed properties), so every binary value marks
 *   the capture normalized instead of proving the loss harmless. Only views
 *   that become `truncated`, or non-Buffer views carrying attached
 *   properties, mark it incomplete.
 * - Raw ArrayBuffer and SharedArrayBuffer values become a fresh empty
 *   ArrayBuffer without copying any bytes; like Maps and Sets they mark the
 *   snapshot normalized, or incomplete when they carry attached properties.
 * - Repeated non-circular references are copied per occurrence so redaction
 *   rules keep matching each path independently.
 * - Own enumerable string-keyed properties of plain objects and class
 *   instances are captured; getters are read at most once, and only when
 *   admitted. Keys are re-checked against their own descriptor at read time,
 *   so keys deleted or hidden by earlier getters are omitted (marking the
 *   snapshot incomplete) instead of falling through to the prototype.
 * - Function values are omitted: their identity and attached data stay
 *   caller-owned, so nothing reachable from a function is copied, invoked, or
 *   exposed to later mutation. Tags never render function values, so the
 *   omission marks the snapshot normalized without making it incomplete.
 * - Arrays are copied key by key, so interior holes stay holes, but the
 *   copy's length ends at its last assigned index and trailing holes are
 *   lost. When that changes the reported length, the snapshot is marked
 *   normalized; holes are never materialized to preserve the length.
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
 * @returns {{ value: unknown, incomplete: boolean, normalized: boolean }}
 */
function createSafeSnapshot (input, budget = createSnapshotBudget()) {
  // The root counts as one admitted entry like every other value.
  if (budget.entries <= 0) {
    return { value: truncated, incomplete: true, normalized: true }
  }
  /** @type {SnapshotState} */
  const state = { value: undefined, incomplete: false, normalized: false, stack: [], budget }
  const { stack } = state
  budget.entries--
  admit(state, undefined, undefined, input, 0)

  while (stack.length > 0) {
    // eslint-disable-next-line unicorn/prefer-at
    const frame = stack[stack.length - 1]

    if (frame.index === frame.keys.length) {
      // The copy is assigned key by key, so trailing holes are lost and the
      // array can be shorter. Holes render no tags, but when the reported
      // length changed, predicates on length or indexes can flip, so mark the
      // capture normalized. Holes are never materialized to preserve the
      // length. Omitted keys mark the capture incomplete where they are read.
      if (frame.sourceLength !== undefined && frame.copy.length !== frame.sourceLength) {
        state.normalized = true
      }
      stack.pop()
      continue
    }

    if (budget.entries <= 0) {
      // Budget exhausted: stop without reading or materializing anything else.
      markIncomplete(state)
      break
    }

    const key = frame.keys[frame.index]
    frame.index++
    budget.entries--
    // Read only once admitted, so getter side effects cannot grow with
    // omitted siblings. Read the current own descriptor: the key may have
    // been deleted or hidden by an earlier getter since enumeration, and an
    // ordinary lookup would then fall through to the prototype, capturing or
    // invoking inherited state. A data property is read directly, an own
    // accessor's getter is invoked exactly once with the source as receiver,
    // and a setter-only accessor reads as undefined. Reflection and getter
    // exceptions reach the fail-soft boundary in payload-tagging/index.js.
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key)
    if (descriptor === undefined || !descriptor.enumerable) {
      markIncomplete(state)
      continue
    }
    let value
    if ('value' in descriptor) {
      value = descriptor.value
    } else if (descriptor.get !== undefined) {
      // Invoke the getter as an intrinsic: an ordinary property access never
      // consults a payload-defined `call` property on the getter.
      value = reflectApply(descriptor.get, frame.source, [])
    }
    admit(state, frame.copy, key, value, frame.childDepth, frame.ancestors)
  }

  return { value: state.value, incomplete: state.incomplete, normalized: state.normalized }
}

module.exports = { createSafeSnapshot, createSnapshotBudget, defineDataProperty }
