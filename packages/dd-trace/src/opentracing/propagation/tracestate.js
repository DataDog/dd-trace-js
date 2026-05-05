'use strict'

// W3C Trace Context §3.3.1.2: max 32 list-members.
// https://www.w3.org/TR/trace-context/#tracestate-header-field-values
const MAX_LIST_MEMBERS = 32
const WHITESPACE = /[ \t]/

/**
 * Parse a separator-delimited string into key/value entries.
 *
 * @param {string} value
 * @param {string} fieldSeparator Between entries.
 * @param {string} pairSeparator Between key and value within an entry.
 * @param {boolean} rejectValueTabs Drop entries whose value contains an internal tab.
 * @returns {[string, string][]} Entries in reverse of wire order.
 */
function parseEntries (value, fieldSeparator, pairSeparator, rejectValueTabs) {
  const segments = value.split(fieldSeparator, MAX_LIST_MEMBERS)

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
    if (!entryValue || rejectValueTabs && entryValue.includes('\t')) continue
    entries.push([key, entryValue])
  }
  // Reverse so the Map's insertion order is reverse of wire order. `toString`
  // prepends as it iterates, which yields the original wire order back.
  entries.reverse()
  return entries
}

function fromString (Type, value, fieldSeparator, pairSeparator, rejectValueTabs) {
  if (typeof value !== 'string' || !value.length) {
    return new Type()
  }
  return new Type(parseEntries(value, fieldSeparator, pairSeparator, rejectValueTabs))
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

class TraceStateData extends Map {
  constructor (...args) {
    super(...args)
    this.changed = false
  }

  set (...args) {
    if (this.has(args[0]) && this.get(args[0]) === args[1]) {
      return
    }
    this.changed = true
    return super.set(...args)
  }

  delete (...args) {
    this.changed = true
    return super.delete(...args)
  }

  clear (...args) {
    this.changed = true
    return super.clear(...args)
  }

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
class TraceState extends Map {
  // Delete entries on update to ensure they're moved to the end of the list
  set (key, value) {
    if (this.has(key)) {
      this.delete(key)
    }

    return super.set(key, value)
  }

  forVendor (vendor, handle) {
    const data = super.get(vendor)
    const state = TraceStateData.fromString(data)
    const result = handle(state)

    if (state.changed) {
      const value = state.toString()
      if (value) {
        this.set(vendor, state.toString())
      } else {
        this.delete(vendor)
      }
    }

    return result
  }

  static fromString (value) {
    return fromString(TraceState, value, ',', '=', true)
  }

  toString () {
    return toString(this, '=', ',')
  }
}

module.exports = TraceState
