'use strict'

// Collects the lines that instrumented modules executed between two test boundaries.
//
// An instrumented module pushes its reader onto `q` the first time it runs after a boundary
// (see instrument.js). A boundary calls those readers, and also the ones it called at the previous
// boundary: a function that was still running when a boundary happened (it called the code that
// ended the test) keeps recording lines without queueing itself again.

const GLOBAL_KEY = Symbol.for('dd-trace.line-coverage')

class LineCoverageCollector {
  /** @type {Function[]} readers queued since the previous boundary; instrumented code pushes here */
  q = []

  /** @type {string[]} */
  #filenames = []

  /** @type {Map<string, number>} */
  #fileIndexes = new Map()

  /** @type {Function[]} */
  #previous = []

  /** @type {number[]} */
  #scratch = []

  stats = { boundaries: 0, readerCalls: 0, lines: 0, takeNs: 0n }

  /**
   * @param {string} filename
   * @returns {number}
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
   * Makes the collector reachable from code that runs with `globalObject` as its global.
   *
   * @param {object} globalObject
   */
  install (globalObject) {
    Object.defineProperty(globalObject, GLOBAL_KEY, {
      value: this,
      configurable: true,
      enumerable: false,
      writable: true,
    })
  }

  /**
   * Reads and clears what ran since the previous boundary.
   *
   * @returns {Array<{ filename: string, bitmap: Buffer }>} covered lines per file, as line bitmaps
   */
  take () {
    const start = process.hrtime.bigint()
    const queued = this.q
    const previous = this.#previous
    this.q = []
    this.#previous = queued

    /** @type {Map<number, Buffer>} */
    const bitmaps = new Map()
    const scratch = this.#scratch
    const seen = new Set()
    let readerCalls = 0
    let lineCount = 0

    for (const readers of [queued, previous]) {
      for (const reader of readers) {
        if (seen.has(reader)) continue
        seen.add(reader)
        readerCalls++
        const count = reader(scratch)
        if (count <= 1) continue
        const file = scratch[0]
        const maxLine = scratch[count - 1]
        let bitmap = bitmaps.get(file)
        const size = (maxLine >> 3) + 1
        if (bitmap === undefined) {
          bitmap = Buffer.alloc(size)
          bitmaps.set(file, bitmap)
        } else if (bitmap.length < size) {
          const larger = Buffer.alloc(size)
          bitmap.copy(larger)
          bitmap = larger
          bitmaps.set(file, bitmap)
        }
        for (let i = 1; i < count; i++) {
          const line = scratch[i]
          bitmap[line >> 3] |= 1 << (line & 7)
        }
        lineCount += count - 1
      }
    }

    const files = []
    for (const [file, bitmap] of bitmaps) {
      files.push({ filename: this.#filenames[file], bitmap })
    }

    const stats = this.stats
    stats.boundaries++
    stats.readerCalls += readerCalls
    stats.lines += lineCount
    stats.takeNs += process.hrtime.bigint() - start
    return files
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

module.exports = { getCollector, LineCoverageCollector, GLOBAL_KEY }
