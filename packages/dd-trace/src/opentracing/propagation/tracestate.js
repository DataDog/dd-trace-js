'use strict'

// W3C Trace Context §3.3.1.2: max 32 list-members.
// https://www.w3.org/TR/trace-context/#tracestate-header-field-values
const MAX_LIST_MEMBERS = 32
const MAX_VALUE_LENGTH = 256
const WHITESPACE = /[ \t]/
const DATADOG_MEMBER = /(?:^|,)\s*dd\s*=/g

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
  /** @type {[string, string][]} */
  const entries = []
  let start = 0
  const entryLimit = maxEntries ?? Infinity
  for (let index = 0; index < entryLimit; index++) {
    const separatorIndex = value.indexOf(fieldSeparator, start)
    const end = separatorIndex === -1 ? value.length : separatorIndex
    const segment = value.slice(start, end)
    const splitIndex = segment.indexOf(pairSeparator)
    if (splitIndex !== -1) {
      const key = segment.slice(0, splitIndex).trim()
      if (key && !WHITESPACE.test(key)) {
        // W3C §3.3.1.3.2: value = 0*255(chr) nblk-chr; chr = %x20 / nblk-chr (no tab).
        // Leading 0x20 is part of value; trailing whitespace is OWS.
        const entryValue = segment.slice(splitIndex + pairSeparator.length).trimEnd()
        if (entryValue &&
          (maxValueLength === undefined || entryValue.length <= maxValueLength) &&
          (!rejectValueTabs || !entryValue.includes('\t'))) entries.push([key, entryValue])
      }
    }
    if (separatorIndex === -1) break
    start = separatorIndex + fieldSeparator.length
  }
  // Reverse so the Map's insertion order is reverse of wire order. `toString`
  // prepends as it iterates, which yields the original wire order back.
  entries.reverse()
  return entries
}

/** @param {string} value */
function findDatadogMember (value) {
  DATADOG_MEMBER.lastIndex = 0
  let datadogMember
  while (DATADOG_MEMBER.test(value)) {
    const nextSeparator = value.indexOf(',', DATADOG_MEMBER.lastIndex)
    let end = nextSeparator === -1 ? value.length : nextSeparator
    while (end > DATADOG_MEMBER.lastIndex && WHITESPACE.test(value[end - 1])) end--
    if (end - DATADOG_MEMBER.lastIndex > MAX_VALUE_LENGTH) continue

    const memberValue = value.slice(DATADOG_MEMBER.lastIndex, end)
    if (memberValue && !memberValue.includes('\t')) {
      datadogMember = memberValue
      break
    }
  }
  return datadogMember
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
   * @param {(key: string, context: Context | undefined) => boolean} isOptional
   * @param {Context | undefined} context
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
    if (typeof value !== 'string' || !value.length) return new TraceStateData()
    return new TraceStateData(parseEntries(value, ';', ':', false))
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
      this.#evictOldest()
    }
  }

  #evictOldest () {
    const keys = this.#map.keys()
    let key = keys.next().value
    if (key === 'dd') key = keys.next().value
    this.#map.delete(key)
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
      this.#evictOldest()
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
   * @param {(key: string, context: Context | undefined) => boolean} [isOptional]
   * @param {Context} [context]
   * @param {(state: TraceStateData, context: Context | undefined) => unknown} [onOverflow]
   * @returns {unknown}
   */
  forVendor (vendor, handle, isOptional, context, onOverflow) {
    const data = this.#map.get(vendor)
    const state = TraceStateData.fromString(data)
    const result = handle(state)

    if (!state.changed) return result

    let value = state.toString()
    if (value.length > MAX_VALUE_LENGTH && isOptional) {
      state.trimOptionalFields(value.length, isOptional, context)
      value = state.toString()
    }
    if (value.length > MAX_VALUE_LENGTH && onOverflow) {
      onOverflow(state, context)
      value = state.toString()
    }
    if (value.length > MAX_VALUE_LENGTH) {
      if (vendor === 'dd') {
        value = `s:${state.get('s')}`
      } else {
        if (isOptional) this.delete(vendor)
        return result
      }
    }
    if (value === data) return result
    if (value) this.set(vendor, value)
    else this.delete(vendor)

    return result
  }

  static fromString (value) {
    if (typeof value !== 'string' || !value.length) return new TraceState()

    const state = new TraceState(parseEntries(value, ',', '=', true, MAX_LIST_MEMBERS, MAX_VALUE_LENGTH))
    if (state.get('dd') !== undefined || !value.includes('dd')) return state

    // The bounded parse can miss dd after 32 members; recover it without retaining the other tail members.
    const datadogMember = findDatadogMember(value)
    if (datadogMember !== undefined) state.set('dd', datadogMember)
    return state
  }

  toString () {
    return toString(this, '=', ',')
  }
}

module.exports = TraceState
