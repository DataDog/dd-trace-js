'use strict'

// Collects the lines that instrumented modules executed and routes them to their owner: a test, a
// suite setup, or nobody. The API in index.js says what owns the running context.
//
// An instrumented module records the slots that ran in module-scope words. At the first probe of
// an activation it calls `touch` unless its touched flag is set (see instrument.js). `touch` asks
// who owns the running context. When the module's words were recorded for another owner, they go
// to that owner first. The module's reader is queued, so the next reset clears its flag. Its words
// stay where they are until a touch finds another owner or a window boundary reads them.
//
// While at most one window is open, `touch` sets the module's flag, and the module skips `touch`
// until the next reset. Resets happen at window boundaries, when a macrotask starts, and when a
// touch finds a different owner than the touches before it. Code that may start a job calls
// `touch` even when the flag is set, so a job that runs in another context is noticed. While
// several windows are open, the flag is never set, and every activation asks.
//
// A reader reports the slots of its module that ran, as bits of 30-slot words. The module's table,
// which the module gives at its first touch, says which file and line each slot stands for, and
// whether the line is initialiser code. Initialiser lines belong to no owner: they go to the per-file
// initialiser set, which the API adds to every test that ran other code of the file, and to the
// initialiser part of Shared.

const GLOBAL_KEY = Symbol.for('dd-trace.line-coverage')

const SLOTS_PER_WORD = 30

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
   * Returns the bitmap of `file`, with at least `length` bytes.
   *
   * @param {number} file
   * @param {number} length
   * @returns {Uint8Array}
   */
  reserve (file, length) {
    let bitmap = this.bitmaps.get(file)
    if (bitmap === undefined) {
      bitmap = new Uint8Array(length)
      this.bitmaps.set(file, bitmap)
    } else if (bitmap.length < length) {
      bitmap = grow(bitmap, length)
      this.bitmaps.set(file, bitmap)
    }
    return bitmap
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
 * @param {string} text integers separated by commas
 * @returns {Int32Array}
 */
function parseIntegers (text) {
  if (text === '') return new Int32Array(0)
  const values = text.split(',')
  const integers = new Int32Array(values.length)
  for (let i = 0; i < values.length; i++) integers[i] = Number(values[i])
  return integers
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

/**
 * Slots recorded for one owner, as 30-slot words per module id.
 */
class Owner {
  open = true

  /** @type {Array<Int32Array | undefined>} */
  words = []

  /** @type {number[]} ids of the modules with words */
  modules = []
}

/**
 * @typedef {{ files: Int32Array, lines: Int32Array, initMasks: Int32Array, bytes: number }} ModuleTable
 *   `bytes` is the length of a bitmap that holds every line of the module
 */

class LineCoverageCollector {
  /** @type {Function[]} readers of the modules touched since the last reset */
  q = []

  /** initialiser lines executed so far, wherever they ran */
  init = new LineSet()

  /** initialiser lines executed since Shared was last taken */
  sharedInit = new LineSet()

  /** what runs in no window, or in a context whose window has closed */
  unowned = new Owner()

  /** @type {Set<Owner>} owners with lines that `takeLines` has not taken yet */
  ownersWithLines = new Set()

  /** whether initialiser lines go to their owner, as in a process that runs for a single test */
  initToOwner = false

  /** @type {() => Owner} returns the owner of the running context */
  resolveOwner = () => this.unowned

  /** @type {string[]} */
  #filenames = []

  /** @type {Map<string, number>} */
  #fileIndexes = new Map()

  /** @type {Function[]} readers queued at the previous window boundary */
  #previous = []

  /** @type {Array<ModuleTable | undefined>} the table of each module copy, by id */
  #modules = []

  /** @type {Map<string, ModuleTable | undefined>} slot tables by module key */
  #tables = new Map()

  /** @type {Array<Owner | undefined>} the owner each module's words were recorded for */
  #owners = []

  /** @type {Uint8Array} 1 for each module whose reader is in `q` */
  #queued = new Uint8Array(64)

  /** @type {Function[]} readers of the modules touched since the last window boundary */
  #touched = []

  /** @type {Uint8Array} 1 for each module whose reader is in `#touched` */
  #isTouched = new Uint8Array(64)

  /** @type {Owner | undefined} the owner the touches since the last reset found */
  #segmentOwner

  #concurrent = false

  /** @type {number[]} */
  #scratch = []

  #generation = 0

  /** @type {(() => void) | undefined} arranges a reset before the next macrotask */
  #scheduleReset

  #resetScheduled = false

  stats = { resets: 0, touches: 0, switches: 0, readerCalls: 0 }

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
   * Called by each copy of an instrumented module the first time it runs, since a framework can run
   * the same code more than once, in module registries that live side by side. Returns the copy's
   * id. Copies of the same code share its slot table.
   *
   * @param {string} key identifies the instrumented code
   * @param {string} sources JSON of the file each source stands for, null for a source whose lines
   *   count nowhere
   * @param {string} lines the line of each slot, negated for initialiser lines, separated by commas
   * @param {string} [sourceOfSlot] the source of each slot, when there is more than one, separated by
   *   commas
   */
  define (key, sources, lines, sourceOfSlot) {
    let table = this.#tables.get(key)
    if (table === undefined) {
      table = this.#createTable(sources, lines, sourceOfSlot)
      this.#tables.set(key, table)
    }
    const id = this.#modules.push(table) - 1
    if (id >= this.#queued.length) {
      this.#queued = grow(this.#queued, id + 1)
      this.#isTouched = grow(this.#isTouched, id + 1)
    }
    return id
  }

  /**
   * @param {string} sources
   * @param {string} lines
   * @param {string} [sourceOfSlot]
   * @returns {ModuleTable | undefined} undefined when the table is not valid: what the module records
   *   then counts nowhere
   */
  #createTable (sources, lines, sourceOfSlot) {
    try {
      const fileOfSource = JSON.parse(sources).map(source => typeof source === 'string' ? this.fileIndex(source) : -1)
      const lineOfSlot = parseIntegers(lines)
      const sourceOfEachSlot = sourceOfSlot === undefined ? undefined : parseIntegers(sourceOfSlot)
      const files = new Int32Array(lineOfSlot.length)
      const initMasks = new Int32Array(Math.ceil(lineOfSlot.length / SLOTS_PER_WORD))
      let lastLine = 0
      for (let slot = 0; slot < lineOfSlot.length; slot++) {
        files[slot] = fileOfSource[sourceOfEachSlot === undefined ? 0 : sourceOfEachSlot[slot]] ?? -1
        if (lineOfSlot[slot] < 0) initMasks[Math.floor(slot / SLOTS_PER_WORD)] |= 1 << (slot % SLOTS_PER_WORD)
        lastLine = Math.max(lastLine, Math.abs(lineOfSlot[slot]))
      }
      return { files, lines: lineOfSlot, initMasks, bytes: (lastLine >> 3) + 1 }
    } catch {}
  }

  createOwner () {
    return new Owner()
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
   * @param {() => void} scheduleReset called when a module is queued after a reset; it must make
   *   `reset` run before the next macrotask
   */
  setResetScheduler (scheduleReset) {
    this.#scheduleReset = scheduleReset
  }

  /**
   * @param {boolean} concurrent whether several windows are open
   */
  setConcurrent (concurrent) {
    this.#concurrent = concurrent
  }

  /**
   * Called by instrumented code. Returns the value of the module's touched flag.
   *
   * @param {number} id
   * @param {Function} reader
   */
  touch (id, reader) {
    let owner
    try {
      owner = this.resolveOwner()
    } catch {
      owner = this.unowned
    }
    this.stats.touches++
    if (owner !== this.#segmentOwner) {
      // The context changed since the modules in `q` were touched: they must ask again.
      if (this.#segmentOwner !== undefined && !this.#concurrent) {
        this.stats.switches++
        this.reset()
      }
      this.#segmentOwner = owner
    }
    const current = this.#owners[id]
    if (current !== owner) {
      if (current !== undefined) this.#read(reader, ++this.#generation)
      this.#owners[id] = owner
    }
    if (this.#queued[id] === 0) {
      this.#queued[id] = 1
      this.q.push(reader)
      if (this.#isTouched[id] === 0) {
        this.#isTouched[id] = 1
        this.#touched.push(reader)
      }
      if (!this.#resetScheduled && this.#scheduleReset !== undefined) {
        this.#resetScheduled = true
        this.#scheduleReset()
      }
    }
    return this.#concurrent ? 0 : 1
  }

  /**
   * Clears the touched flags of the modules touched since the last reset, so their next activation
   * asks who owns it.
   */
  reset () {
    this.#resetScheduled = false
    this.#segmentOwner = undefined
    const queued = this.q
    if (queued.length === 0) return
    this.stats.resets++
    for (let i = 0; i < queued.length; i++) this.#queued[queued[i](null, 0)] = 0
    queued.length = 0
  }

  /**
   * A reset at a window boundary, which moves the words of every module touched since the previous
   * boundary to their owners. It also reads the modules queued at the previous boundary: a function
   * that was running when that boundary happened keeps recording without touching.
   */
  boundary () {
    this.#resetScheduled = false
    this.#segmentOwner = undefined
    const touched = this.#touched
    const previous = this.#previous
    const generation = ++this.#generation
    for (let i = 0; i < touched.length; i++) {
      // Every module in `q` is among them, so this clears every touched flag.
      const id = this.#read(touched[i], generation)
      if (id !== -1) {
        this.#isTouched[id] = 0
        this.#queued[id] = 0
      }
    }
    touched.length = 0
    for (let i = 0; i < previous.length; i++) this.#read(previous[i], generation)
    previous.length = 0
    this.#previous = this.q
    this.q = previous
  }

  /**
   * Calls `reader` and moves the slots it reports to the module's owner. Returns the module id, or
   * -1 when the reader already ran for `generation`.
   *
   * @param {Function} reader
   * @param {number} generation
   */
  #read (reader, generation) {
    const scratch = this.#scratch
    const count = reader(scratch, generation)
    if (count === 0) return -1
    const id = scratch[0]
    this.stats.readerCalls++
    if (count === 1) return id
    const module = this.#modules[id]
    if (module === undefined) return id
    let owner = this.#owners[id]
    if (owner === undefined || !owner.open) owner = this.unowned
    let words = owner.words[id]
    if (words === undefined) {
      words = new Int32Array(module.initMasks.length)
      owner.words[id] = words
      if (owner.modules.length === 0) this.ownersWithLines.add(owner)
      owner.modules.push(id)
    }
    const initMasks = module.initMasks
    const initToOwner = this.initToOwner
    for (let i = 1; i < count; i += 2) {
      const word = scratch[i]
      const bits = scratch[i + 1]
      const init = initToOwner ? 0 : bits & initMasks[word]
      if (init !== 0) this.#addInit(module, word, init)
      words[word] |= bits & ~init
    }
    return id
  }

  /**
   * @param {ModuleTable} module
   * @param {number} word
   * @param {number} bits
   */
  #addInit (module, word, bits) {
    const { files, lines } = module
    const base = word * SLOTS_PER_WORD
    while (bits !== 0) {
      const lowest = bits & -bits
      bits ^= lowest
      const slot = base + 31 - Math.clz32(lowest)
      const file = files[slot]
      if (file === -1) continue
      this.init.add(file, -lines[slot])
      this.sharedInit.add(file, -lines[slot])
    }
  }

  /**
   * Adds the lines recorded for `owner` to `target`, and forgets them.
   *
   * @param {Owner} owner
   * @param {LineSet} target
   */
  takeLines (owner, target) {
    for (const id of owner.modules) {
      const words = owner.words[id]
      const module = this.#modules[id]
      owner.words[id] = undefined
      if (words === undefined || module === undefined) continue
      const { files, lines, bytes } = module
      let file = -1
      let bitmap
      for (let word = 0; word < words.length; word++) {
        let bits = words[word]
        const base = word * SLOTS_PER_WORD
        while (bits !== 0) {
          const lowest = bits & -bits
          bits ^= lowest
          const slot = base + 31 - Math.clz32(lowest)
          const slotFile = files[slot]
          if (slotFile === -1) continue
          if (slotFile !== file) {
            file = slotFile
            bitmap = target.reserve(file, bytes)
          }
          // Initialiser lines are negated; they reach an owner only when `initToOwner` is set.
          const line = Math.abs(lines[slot])
          bitmap[line >> 3] |= 1 << (line & 7)
        }
      }
    }
    owner.modules.length = 0
    this.ownersWithLines.delete(owner)
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

module.exports = { getCollector, LineCoverageCollector, LineSet, Owner, GLOBAL_KEY }
