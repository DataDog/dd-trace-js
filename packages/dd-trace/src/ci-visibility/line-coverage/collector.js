'use strict'

// Collects the lines that instrumented modules executed and routes them to their owner: a test, a
// suite setup, or nobody. The API in index.js says what owns the running context.
//
// An instrumented module records the slots that ran in module-scope words. At the first probe of
// an activation it calls `touch` unless its touched flag is set (see instrument.js). `touch` asks
// who owns the running context. When the module's words were recorded for another owner, they go
// to that owner first. The module's reader is queued, so the next reset moves its words to its
// owner and clears its flag.
//
// While at most one window is open, `touch` sets the module's flag, and the module skips `touch`
// until the next reset. Resets happen at window boundaries, when a macrotask starts that may run in
// another context, and when a touch finds a different owner than the touches before it. Code that
// may start a job calls `touch` even when the flag is set, so a job that runs in another context is
// noticed. While several windows are open, the flag is never set, and every activation asks.
//
// A reader reports the slots of its module that ran, as bits of 30-slot words. The module's table,
// which the module gives at its first touch, says which file and line each slot stands for, and
// whether the line is initialiser code. Initialiser lines belong to no owner: they go to the
// initialiser set of their file, and to the initialiser part of Shared. Taking an owner's lines adds,
// for each file whose other code the owner ran, the initialiser lines that file ran so far. The set
// is for the whole process: when a framework runs a module more than once, such as Jest once per test
// file, each copy's initialiser lines count for every copy, whichever branch the copy took.

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
 * @typedef {{ files: Int32Array, lines: Int32Array, initMasks: Int32Array }} ModuleTable
 */

class LineCoverageCollector {
  /** @type {Function[]} readers of the modules touched since the last reset */
  q = []

  /** initialiser lines executed since Shared was last taken */
  sharedInit = new LineSet()

  /** initialiser lines executed in the process, in any module copy */
  init = new LineSet()

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
   * @param {Array<string | null>} sources the file each source stands for, null for a source whose
   *   lines count nowhere
   * @param {number[]} lines the line of each slot, negated for initialiser lines
   * @param {number[]} [sourceOfSlot] the source of each slot, when there is more than one
   */
  define (key, sources, lines, sourceOfSlot) {
    let table = this.#tables.get(key)
    if (table === undefined) {
      table = this.#createTable(sources, lines, sourceOfSlot)
      this.#tables.set(key, table)
    }
    const id = this.#modules.push(table) - 1
    if (id >= this.#queued.length) {
      const queued = new Uint8Array(this.#queued.length * 2)
      queued.set(this.#queued)
      this.#queued = queued
    }
    return id
  }

  /**
   * @param {Array<string | null>} sources
   * @param {number[]} lines
   * @param {number[]} [sourceOfSlot]
   * @returns {ModuleTable | undefined} undefined when the table is not valid: what the module records
   *   then counts nowhere
   */
  #createTable (sources, lines, sourceOfSlot) {
    try {
      const fileOfSource = sources.map(source => typeof source === 'string' ? this.fileIndex(source) : -1)
      const files = new Int32Array(lines.length)
      const initMasks = new Int32Array(Math.ceil(lines.length / SLOTS_PER_WORD))
      for (let slot = 0; slot < lines.length; slot++) {
        files[slot] = fileOfSource[sourceOfSlot === undefined ? 0 : sourceOfSlot[slot]] ?? -1
        if (lines[slot] < 0) initMasks[Math.floor(slot / SLOTS_PER_WORD)] |= 1 << (slot % SLOTS_PER_WORD)
      }
      return { files, lines: Int32Array.from(lines), initMasks }
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
    const owner = this.#resolveOwner()
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
      if (!this.#resetScheduled && this.#scheduleReset !== undefined) {
        this.#resetScheduled = true
        this.#scheduleReset()
      }
    }
    return this.#concurrent ? 0 : 1
  }

  /** @returns {Owner} */
  #resolveOwner () {
    try {
      return this.resolveOwner()
    } catch {
      return this.unowned
    }
  }

  /**
   * A reset where a macrotask starts, in its context. The touches since the last reset still hold
   * when they found the owner of that context, unless several windows are open.
   */
  startMacrotask () {
    const segmentOwner = this.#segmentOwner
    if (segmentOwner !== undefined && !this.#concurrent && this.#resolveOwner() === segmentOwner) return
    this.reset()
  }

  /**
   * Moves the words of the modules touched since the last reset to their owners, and clears their
   * touched flags.
   */
  reset () {
    this.#resetScheduled = false
    this.#segmentOwner = undefined
    const queued = this.q
    if (queued.length === 0) return
    this.stats.resets++
    const generation = ++this.#generation
    for (let i = 0; i < queued.length; i++) this.#unqueue(this.#read(queued[i], generation))
    queued.length = 0
  }

  /**
   * A reset at a window boundary. It also reads the modules queued at the previous boundary: a
   * function that was running when that boundary happened keeps recording without touching.
   */
  boundary () {
    this.#resetScheduled = false
    this.#segmentOwner = undefined
    const queued = this.q
    const previous = this.#previous
    const generation = ++this.#generation
    for (let i = 0; i < queued.length; i++) this.#unqueue(this.#read(queued[i], generation))
    for (let i = 0; i < previous.length; i++) this.#read(previous[i], generation)
    previous.length = 0
    this.#previous = queued
    this.q = previous
  }

  /**
   * @param {number} id a module id, or -1
   */
  #unqueue (id) {
    if (id !== -1) this.#queued[id] = 0
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
   * Adds the lines recorded for `owner` to `target`, and forgets them. Unless `owner` is the
   * unowned one, it also gets the initialiser lines of each file whose other code it ran.
   *
   * @param {Owner} owner
   * @param {LineSet} target
   */
  takeLines (owner, target) {
    /** @type {Set<number> | undefined} */
    const filesRun = owner === this.unowned ? undefined : new Set()
    for (const id of owner.modules) {
      const words = owner.words[id]
      const module = this.#modules[id]
      owner.words[id] = undefined
      if (words === undefined || module === undefined) continue
      const { files, lines } = module
      let previousFile = -1
      for (let word = 0; word < words.length; word++) {
        let bits = words[word]
        const base = word * SLOTS_PER_WORD
        while (bits !== 0) {
          const lowest = bits & -bits
          bits ^= lowest
          const slot = base + 31 - Math.clz32(lowest)
          const file = files[slot]
          if (file === -1) continue
          // Initialiser lines are negated; they are in `words` only when `initToOwner` is set.
          target.add(file, Math.abs(lines[slot]))
          if (filesRun !== undefined && file !== previousFile) {
            previousFile = file
            filesRun.add(file)
          }
        }
      }
    }
    if (filesRun !== undefined) {
      const init = this.init.bitmaps
      for (const file of filesRun) {
        const initBitmap = init.get(file)
        if (initBitmap !== undefined) target.addBitmap(file, initBitmap)
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
