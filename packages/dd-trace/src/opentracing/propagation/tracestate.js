'use strict'

const traceStateRegex = /[ \t]*([^=]+)=([ \t]*[^, \t]+)[ \t]*(,|$)/gim
const traceStateDataRegex = /([^:]+):([^;]+)(;|$)/gim

// V8 takes the Map.prototype constructor on subclasses through a slower
// reflection path (~1.8x slower for `new Sub(arrayOfPairs)` in microbench).
// Compose a private `Map` instead and forward only what callers use.

function fromString (Type, regex, value) {
  if (typeof value !== 'string' || !value.length) {
    return new Type()
  }

  // Pairs are stored in reverse of the serialized format (see TraceState),
  // but `Array#unshift` inside the loop is O(n) per insert -> O(n²) total.
  // Push then reverse once to get the same final order in O(n).
  const values = []
  for (const row of value.matchAll(regex)) {
    values.push(row.slice(1, 3))
  }
  values.reverse()

  return new Type(values)
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
    if (this.#map.get(key) === value && this.#map.has(key)) return this
    this.changed = true
    this.#map.set(key, value)
    return this
  }

  get (key) {
    return this.#map.get(key)
  }

  has (key) {
    return this.#map.has(key)
  }

  delete (key) {
    this.changed = true
    return this.#map.delete(key)
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
class TraceState {
  #map

  constructor (entries) {
    this.#map = entries ? new Map(entries) : new Map()
  }

  // Delete entries on update to ensure they're moved to the end of the list
  set (key, value) {
    if (this.#map.has(key)) this.#map.delete(key)
    this.#map.set(key, value)
    return this
  }

  get (key) {
    return this.#map.get(key)
  }

  has (key) {
    return this.#map.has(key)
  }

  delete (key) {
    return this.#map.delete(key)
  }

  clear () {
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

  forVendor (vendor, handle) {
    const data = this.#map.get(vendor)
    const state = TraceStateData.fromString(data)
    const result = handle(state)

    if (state.changed) {
      const value = state.toString()
      if (value) {
        this.set(vendor, value)
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
