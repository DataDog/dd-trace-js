'use strict'

const traceStateRegex = /[ \t]*([^=]+)=([ \t]*[^, \t]+)[ \t]*(,|$)/gim
const traceStateDataRegex = /([^:]+):([^;]+)(;|$)/gim

function fromString (Type, regex, value) {
  if (typeof value !== 'string' || !value.length) {
    return new Type()
  }

  const values = []
  for (const row of value.matchAll(regex)) {
    values.unshift(row.slice(1, 3))
  }

  return new Type(values)
}

function toString (map, pairSeparator, fieldSeparator) {
  return Array.from(map.entries())
    .reverse()
    .map((pair) => pair.join(pairSeparator))
    .join(fieldSeparator)
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
    return fromString(TraceStateData, traceStateDataRegex, value)
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
    return fromString(TraceState, traceStateRegex, value)
  }

  toString () {
    return toString(this, '=', ',')
  }
}

module.exports = TraceState
