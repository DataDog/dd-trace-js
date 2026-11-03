'use strict'

// W3C Trace Context §3.3.1.2: max 32 list-members.
// https://www.w3.org/TR/trace-context/#tracestate-header-field-values
const MAX_LIST_MEMBERS = 32
const MAX_VALUE_LENGTH = 256
const WHITESPACE = /[ \t]/

/**
 * Parse a separator-delimited string into key/value entries.
 *
 * @param {string} value
 * @param {string} fieldSeparator Between entries.
 * @param {string} pairSeparator Between key and value within an entry.
 * @param {boolean} rejectValueTabs Drop entries whose value contains an internal tab.
 * @param {number} [maxEntries] Maximum number of entries to parse.
 * @param {number} [maxValueLength] Maximum length of an entry value.
 * @returns {[string, string][]} Entries in reverse of wire order.
 */
function parseEntries (value, fieldSeparator, pairSeparator, rejectValueTabs, maxEntries, maxValueLength) {
  const segments = value.split(fieldSeparator, maxEntries)

  // TODO: We should extract dd no matter at what position and move it to the front of the list.
  // Extract up 31 additional entries.
  const entries = []
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const splitIndex = segment.indexOf(pairSeparator)
    if (splitIndex === -1) continue
    const key = segment.slice(0, splitIndex).trim()
    if (!key || WHITESPACE.test(key)) continue
    // W3C §3.3.1.3.2: value = 0*255(chr) nblk-chr; chr = %x20 / nblk-chr (no tab).
    // Leading 0x20 is part of value; trailing whitespace is OWS.
    const entryValue = segment.slice(splitIndex + 1).trimEnd()
    if (!entryValue ||
      maxValueLength !== undefined && entryValue.length > maxValueLength ||
      rejectValueTabs && entryValue.includes('\t')) continue
    entries.push([key, entryValue])
  }
  // Reverse so the Map's insertion order is reverse of wire order. `toString`
  // prepends as it iterates, which yields the original wire order back.
  entries.reverse()
  return entries
}

/**
 * @param {typeof TraceState | typeof TraceStateData} Type
 * @param {string | undefined} value
 * @param {string} fieldSeparator
 * @param {string} pairSeparator
 * @param {boolean} rejectValueTabs
 * @param {number} [maxEntries]
 * @param {number} [maxValueLength]
 * @returns {TraceState | TraceStateData}
 */
function fromString (Type, value, fieldSeparator, pairSeparator, rejectValueTabs, maxEntries, maxValueLength) {
  if (typeof value !== 'string' || !value.length) {
    return new Type()
  }
  return new Type(parseEntries(value, fieldSeparator, pairSeparator, rejectValueTabs, maxEntries, maxValueLength))
}

function toString (map, pairSeparator, fieldSeparator) {
  let result = ''
  for (const [key, value] of map) {
    if (result) {
      result = `${fieldSeparator}${result}`
    }
    result = `${key}${pairSeparator}${value}${result}`
  }
  return result
}

class TraceStateData {
  #map
  changed = false

  constructor (entries) {
    this.#map = entries ? new Map(entries) : new Map()
  }

  set (key, value) {
    if (this.#map.get(key) === value && (value !== undefined || this.#map.has(key))) return this
    this.changed = true
    this.#map.set(key, value)
    return this
  }

  get (key) {
    return this.#map.get(key)
  }

  delete (key) {
    if (!this.#map.delete(key)) return false
    this.changed = true
    return true
  }

  clear () {
    this.changed = true
    this.#map.clear()
  }

  entries () {
    return this.#map.entries()
  }

  [Symbol.iterator] () {
    return this.#map[Symbol.iterator]()
  }

  get size () {
    return this.#map.size
  }

  /**
   * @template Context
   * @param {number} valueLength
   * @param {(key: string, context: Context) => boolean} isOptional
   * @param {Context} context
   */
  trimOptionalFields (valueLength, isOptional, context) {
    const fields = [...this.#map]
    for (let index = fields.length - 1; index >= 0 && valueLength > MAX_VALUE_LENGTH; index--) {
      const [key, value] = fields[index]
      if (!isOptional(key, context)) continue

      valueLength -= key.length + String(value).length + (this.#map.size > 1 ? 2 : 1)
      this.delete(key)
    }
  }

  /** @param {string | undefined} value */
  static fromString (value) {
    return fromString(TraceStateData, value, ';', ':', false)
  }

  toString () {
    return toString(this, ':', ';')
  }
}

/**
 * Pairs are stored in reverse of the serialized format to rely on set ordering
 * new entries at the end to express update movement.
 */
class TraceState {
  #map

  constructor (entries) {
    this.#map = entries ? new Map(entries) : new Map()
    while (this.#map.size > MAX_LIST_MEMBERS) {
      this.#map.delete(this.#map.keys().next().value)
    }
  }

  // Delete entries on update to ensure they're moved to the end of the list
  /**
   * @param {string} key
   * @param {string} value
   */
  set (key, value) {
    if (value.length > MAX_VALUE_LENGTH) return this
    const updated = this.#map.delete(key)
    if (!updated && this.#map.size === MAX_LIST_MEMBERS) {
      this.#map.delete(this.#map.keys().next().value)
    }
    this.#map.set(key, value)
    return this
  }

  get (key) {
    return this.#map.get(key)
  }

  delete (key) {
    return this.#map.delete(key)
  }

  [Symbol.iterator] () {
    return this.#map[Symbol.iterator]()
  }

  get size () {
    return this.#map.size
  }

  /** @returns {TraceState} A shallow copy with independent member storage. */
  clone () {
    return new TraceState(this.#map)
  }

  /**
   * @template Context
   * @param {string} vendor
   * @param {(state: TraceStateData) => unknown} handle
   * @param {(key: string, context: Context) => boolean} [isOptional]
   * @param {Context} [context]
   * @returns {unknown}
   */
  forVendor (vendor, handle, isOptional, context) {
    const data = this.#map.get(vendor)
    const state = TraceStateData.fromString(data)
    const result = handle(state)

    if (!state.changed) return result

    let value = state.toString()
    if (value.length > MAX_VALUE_LENGTH && isOptional) {
      state.trimOptionalFields(value.length, isOptional, context)
      value = state.toString()
    }
    if (value.length > MAX_VALUE_LENGTH) {
      if (isOptional) this.delete(vendor)
      return result
    }
    if (value === data) return result
    if (value) this.set(vendor, value)
    else this.delete(vendor)

    return result
  }

  static fromString (value) {
    return fromString(TraceState, value, ',', '=', true, MAX_LIST_MEMBERS, MAX_VALUE_LENGTH)
  }

  toString () {
    return toString(this, '=', ',')
  }
}

module.exports = TraceState
