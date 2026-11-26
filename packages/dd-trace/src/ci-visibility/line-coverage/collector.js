'use strict'

// Collects the lines that instrumented modules executed, and routes them at every boundary to the
// set of the window that was open since the previous boundary.
//
// An instrumented module pushes its reader onto `q` the first time it runs after a boundary (see
// instrument.js). A boundary calls those readers, and also the ones it called at the previous
// boundary: a function that was still running when a boundary happened (it called the code that
// ended the window) keeps recording lines without queueing itself again.
//
// Readers report initialiser lines as negative numbers. Those never belong to a window: they go to
// the per-file initialiser set, which the API adds to every test that ran other code of the file.

const GLOBAL_KEY = Symbol.for('dd-trace.line-coverage')

/**
 * Lines per file, as bitmaps keyed by the collector's file index: bit `1 << (line & 7)` of byte
 * `line >> 3`, the layout of the coverage payload.
 */
class LineSet {
  /** @type {Map<number, Uint8Array>} */
  bitmaps = new Map()

  /**
   * @param {number} file
   * @param {number} line
   */
  add (file, line) {
    const byte = line >> 3
    let bitmap = this.bitmaps.get(file)
    if (bitmap === undefined) {
      bitmap = new Uint8Array(byte < 32 ? 32 : byte + 1)
      this.bitmaps.set(file, bitmap)
    } else if (byte >= bitmap.length) {
      bitmap = grow(bitmap, byte + 1)
      this.bitmaps.set(file, bitmap)
    }
    bitmap[byte] |= 1 << (line & 7)
  }

  /**
   * @param {number} file
   * @param {Uint8Array} source
   */
  addBitmap (file, source) {
    let bitmap = this.bitmaps.get(file)
    if (bitmap === undefined) {
      this.bitmaps.set(file, new Uint8Array(source))
      return
    }
    if (bitmap.length < source.length) {
      bitmap = grow(bitmap, source.length)
      this.bitmaps.set(file, bitmap)
    }
    for (let i = 0; i < source.length; i++) bitmap[i] |= source[i]
  }

  /**
   * @param {LineSet} other
   */
  addAll (other) {
    for (const [file, bitmap] of other.bitmaps) this.addBitmap(file, bitmap)
  }
}

/**
 * @param {Uint8Array} bitmap
 * @param {number} minLength
 * @returns {Uint8Array}
 */
function grow (bitmap, minLength) {
  const larger = new Uint8Array(Math.max(minLength, bitmap.length * 2))
  larger.set(bitmap)
  return larger
}

class LineCoverageCollector {
  /** @type {Function[]} readers queued since the previous boundary; instrumented code pushes here */
  q = []

  /** initialiser lines executed so far, wherever they ran */
  init = new LineSet()

  /** @type {string[]} */
  #filenames = []

  /** @type {Map<string, number>} */
  #fileIndexes = new Map()

  /** @type {Function[]} */
  #previous = []

  /** @type {number[]} */
  #scratch = []

  #generation = 0

  stats = { boundaries: 0, readerCalls: 0, lines: 0, takeNs: 0n }

  /**
   * @param {string} filename
   */
  fileIndex (filename) {
    let index = this.#fileIndexes.get(filename)
    if (index === undefined) {
      index = this.#filenames.length
      this.#filenames.push(filename)
      this.#fileIndexes.set(filename, index)
    }
    return index
  }

  /**
   * @param {number} index
   */
  filename (index) {
    return this.#filenames[index]
  }

  /**
   * Makes the collector reachable from code that runs with `globalObject` as its global.
   *
   * @param {object} globalObject
   */
  install (globalObject) {
    if (globalObject[GLOBAL_KEY] === this) return
    Object.defineProperty(globalObject, GLOBAL_KEY, {
      value: this,
      configurable: true,
      enumerable: false,
      writable: true,
    })
  }

  /**
   * Moves what ran since the previous boundary into `target`, initialiser lines excepted.
   *
   * @param {LineSet} target
   */
  take (target) {
    const start = process.hrtime.bigint()
    const queued = this.q
    const previous = this.#previous
    const scratch = this.#scratch
    const init = this.init
    const generation = ++this.#generation
    let readerCalls = 0
    let lineCount = 0

    for (let pass = 0; pass < 2; pass++) {
      const readers = pass === 0 ? queued : previous
      for (let r = 0; r < readers.length; r++) {
        const count = readers[r](scratch, generation)
        if (count === 0) continue
        readerCalls++
        const file = scratch[0]
        for (let i = 1; i < count; i++) {
          const line = scratch[i]
          if (line > 0) {
            target.add(file, line)
          } else {
            init.add(file, -line)
          }
        }
        lineCount += count - 1
      }
    }

    previous.length = 0
    this.#previous = queued
    this.q = previous

    const stats = this.stats
    stats.boundaries++
    stats.readerCalls += readerCalls
    stats.lines += lineCount
    stats.takeNs += process.hrtime.bigint() - start
  }
}

/** @type {LineCoverageCollector | undefined} */
let collector

function getCollector () {
  if (!collector) {
    collector = new LineCoverageCollector()
    collector.install(globalThis)
  }
  return collector
}

module.exports = { getCollector, LineCoverageCollector, LineSet, GLOBAL_KEY }
