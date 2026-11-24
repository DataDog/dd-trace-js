'use strict'

// Per-test line coverage: what each test executed, as defined for the accuracy checker.
//
//   Cov(test) = own lines ∪ fixture lines ∪ initialiser lines
//
// Own lines ran inside the test's window, in a context that carries the test. The window opens
// before the test's per-test hooks and closes after them. A context carries the test when dd-trace's
// active span belongs to the test's trace: the test's own context, everything started from it, and
// requests handled for it in the same process when trace context reaches them. Fixture lines ran in
// a suite-scope setup hook (beforeAll) of a suite enclosing the test, in a context opened for that
// hook, while it ran. Initialiser lines (module top level, static members of classes defined there)
// belong to no window: every test that ran other lines of a file gets the initialiser lines of that
// file. Everything else is reported once per process as Shared, in three parts: initialiser lines,
// suite setup lines, and the rest (unowned): what ran outside every window, in a context that carries
// no open window, or in one whose window had closed.
//
// A framework integration calls, in each process that runs tests:
//   enable({ root })                    once; instruments CommonJS modules under root as they load
//   instrumentSource(code, filename, options)  for modules the framework compiles itself
//   installGlobal(globalObject)         for every other realm instrumented code runs in
//   startTest(span) / finishTest(test, suites)
//   startSuiteSetup(suite) / finishSuiteSetup(), and runs each suite setup hook in suiteSetupStore()
//   takeShared()                        after the last test, or after each test file

const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const dc = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const { addChildProcessEnv } = require('../../child-process-env')
const { getEnvironmentVariable } = require('../../config/helper')
const log = require('../../log')
const { getCollector, LineSet } = require('./collector')
const { instrument } = require('./instrument')
const { createPositionMapper, readSourceMap } = require('./source-map')

/**
 * @typedef {{ filename: string, bitmap: Buffer }} FileCoverage
 * @typedef {import('./collector').Owner} Owner
 */

const legacyStorage = storage('legacy')

// Marks the context opened for a suite setup hook. Stores derived from it keep it.
const SUITE_SETUP_OWNER = Symbol('dd-trace.line-coverage.suite-setup')

// A child process started for a test (or suite setup) gets these variables. It counts everything it
// runs as that owner's and, at exit, writes it to `<target>-<pid>.json`.
const CHILD_TARGET = '_DD_LINE_COVERAGE_CHILD'
const CHILD_ROOT = '_DD_LINE_COVERAGE_ROOT'

let enabled = false
let rootPrefix = ''
const stats = { files: 0, instrumentNs: 0n, failures: 0, bytesIn: 0, bytesOut: 0 }

let unownedLines = new LineSet()
let suiteSetup = new LineSet()

/** @type {WeakMap<object, LineSet>} lines of each suite's setup hooks */
const fixtures = new WeakMap()

/** @type {Set<Owner>} */
const openTests = new Set()

/** @type {{ suite: object, owner: Owner } | undefined} */
let openSetup

/** @type {WeakMap<object, Owner>} test owners by the trace object their spans share */
const ownerByTrace = new WeakMap()

/** @type {Map<string, Owner>} open test owners by trace id, for spans continued from propagated headers */
const ownerByTraceId = new Map()

/** @type {WeakMap<Owner, string>} */
const traceIdByOwner = new WeakMap()

/** @type {string | undefined} where children write their lines */
let childDirectory
let childTargets = 0
/** @type {WeakMap<Owner, string>} the target of each owner that started children */
const childTargetByOwner = new WeakMap()
/** @type {string | undefined} the target this process writes to, when it is such a child */
let ownTarget

const NO_STORE = {}
let cachedStore = NO_STORE
/** @type {Owner | undefined} */
let cachedOwner

/** @type {string[]} filenames relative to the root, by file index */
const relativeFilenames = []

/** @type {Map<string, { code: string, instrumented: string }>} */
const instrumentedByFilename = new Map()

function isEnabled () {
  const value = getEnvironmentVariable('DD_TEST_LINE_COVERAGE_ENABLED')
  return value === 'true' || value === '1'
}

function isActive () {
  return enabled
}

/**
 * The owner of the running context: the test or suite setup whose open window it carries, or the
 * unowned part of Shared.
 *
 * @returns {Owner}
 */
function resolveOwner () {
  const store = legacyStorage.getStore()
  if (store === cachedStore) return cachedOwner
  cachedStore = store
  cachedOwner = findOwner(store)
  return cachedOwner
}

/**
 * @param {object | undefined} store
 * @returns {Owner}
 */
function findOwner (store) {
  const collector = getCollector()
  if (!store) return collector.unowned
  let owner
  const span = store.span
  if (span && typeof span.context === 'function') {
    const context = span.context()
    if (context?._trace) owner = ownerByTrace.get(context._trace)
    if (owner === undefined && ownerByTraceId.size > 0 && context?._traceId) {
      owner = ownerByTraceId.get(context._traceId.toString(16))
    }
  }
  owner ??= store[SUITE_SETUP_OWNER]
  return owner?.open ? owner : collector.unowned
}

// Called at every window boundary, after the collector moved what ran so far to its owners.
function updateWindows () {
  cachedStore = NO_STORE
  getCollector().setConcurrent(openTests.size + (openSetup ? 1 : 0) > 1)
}

function closeSetup () {
  if (!openSetup) return
  const collector = getCollector()
  collector.boundary()
  const { suite, owner } = openSetup
  openSetup = undefined
  owner.open = false
  updateWindows()
  const lines = new LineSet()
  collector.takeLines(owner, lines)
  takeChildLines(owner, lines)
  let fixture = fixtures.get(suite)
  if (fixture === undefined) {
    fixture = new LineSet()
    fixtures.set(suite, fixture)
  }
  fixture.addAll(lines)
  suiteSetup.addAll(lines)
}

/**
 * Opens a test's window. Call it when the framework starts the test, before per-test hooks, once
 * the test's span exists.
 *
 * @param {object} [span] the test's span; work in contexts whose active span belongs to its trace
 *   is the test's
 * @returns {Owner}
 */
function startTest (span) {
  closeSetup()
  const collector = getCollector()
  collector.boundary()
  const test = collector.createOwner()
  const context = typeof span?.context === 'function' ? span.context() : undefined
  if (context?._trace) ownerByTrace.set(context._trace, test)
  if (context?._traceId) {
    const traceId = context._traceId.toString(16)
    ownerByTraceId.set(traceId, test)
    traceIdByOwner.set(test, traceId)
  }
  openTests.add(test)
  updateWindows()
  return test
}

/**
 * Closes a test's window, after its per-test hooks, and returns its coverage.
 *
 * @param {Owner} test
 * @param {Iterable<object>} [suites] the suites enclosing the test, as passed to startSuiteSetup
 * @returns {FileCoverage[]}
 */
function finishTest (test, suites) {
  if (!openTests.has(test)) return []
  const collector = getCollector()
  collector.boundary()
  openTests.delete(test)
  test.open = false
  const traceId = traceIdByOwner.get(test)
  if (traceId !== undefined && ownerByTraceId.get(traceId) === test) ownerByTraceId.delete(traceId)
  updateWindows()
  const coverage = new LineSet()
  collector.takeLines(test, coverage)
  takeChildLines(test, coverage)
  if (suites) {
    for (const suite of suites) {
      const fixture = fixtures.get(suite)
      if (fixture !== undefined) coverage.addAll(fixture)
    }
  }
  if (dumpPath) testUnion.addAll(coverage)
  const init = collector.init.bitmaps
  for (const file of coverage.bitmaps.keys()) {
    const initLines = init.get(file)
    if (initLines !== undefined) coverage.addBitmap(file, initLines)
  }
  return toFiles(coverage)
}

/**
 * Opens the window of a suite-scope setup hook (beforeAll) of `suite`. Its lines become part of
 * every test that passes `suite` to finishTest. The hook must run in `suiteSetupStore()`.
 *
 * @param {object} suite
 */
function startSuiteSetup (suite) {
  closeSetup()
  const collector = getCollector()
  collector.boundary()
  openSetup = { suite, owner: collector.createOwner() }
  updateWindows()
}

/**
 * Returns the store a suite setup hook runs in: `store`, marked with the open suite setup window.
 *
 * @template {object} T
 * @param {T} store
 * @returns {T}
 */
function suiteSetupStore (store) {
  if (!openSetup) return store
  return { ...store, [SUITE_SETUP_OWNER]: openSetup.owner }
}

/**
 * Closes the open suite setup window, if any. Call it after each suite setup hook, and before any
 * other suite-scope hook.
 */
function finishSuiteSetup () {
  closeSetup()
}

/**
 * Returns Shared, what ran outside every test window since the previous call, in three parts.
 *
 * @returns {Array<{ shared: 'init' | 'suiteSetup' | 'unowned', files: FileCoverage[] }>}
 */
function takeShared () {
  closeSetup()
  const collector = getCollector()
  collector.boundary()
  collector.takeLines(collector.unowned, unownedLines)
  takeLateChildLines(unownedLines)
  const shared = [
    { shared: 'init', files: toFiles(collector.sharedInit) },
    { shared: 'suiteSetup', files: toFiles(suiteSetup) },
    { shared: 'unowned', files: toFiles(unownedLines) },
  ]
  collector.sharedInit = new LineSet()
  suiteSetup = new LineSet()
  unownedLines = new LineSet()
  return shared
}

const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

/**
 * Gives a child process started for a test or a suite setup the variables that make it report
 * what it runs to that owner. A child passes its own target on to its children.
 *
 * @param {{ callArgs?: unknown[], shell?: boolean }} context
 */
function onChildProcessStart (context) {
  try {
    const target = ownTarget ?? targetFor(resolveOwner())
    if (target === undefined) return
    addChildProcessEnv(context, { [CHILD_TARGET]: target, [CHILD_ROOT]: rootPrefix })
  } catch (error) {
    log.debug('Line coverage could not follow a child process: %s', error.message)
  }
}

/**
 * @param {Owner} owner
 * @returns {string | undefined}
 */
function targetFor (owner) {
  if (owner === getCollector().unowned) return
  let target = childTargetByOwner.get(owner)
  if (target === undefined) {
    childDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'dd-line-coverage-'))
    target = path.join(childDirectory, String(++childTargets))
    childTargetByOwner.set(owner, target)
  }
  return target
}

/**
 * Adds what the children of a closing owner wrote to `lines`. A child that is still running
 * writes later, and its lines go to Shared.
 *
 * @param {Owner} owner
 * @param {LineSet} lines
 */
function takeChildLines (owner, lines) {
  const target = childTargetByOwner.get(owner)
  if (target === undefined) return
  childTargetByOwner.delete(owner)
  readChildLines(name => name.startsWith(`${path.basename(target)}-`), lines)
}

/**
 * Adds what children wrote after their owner closed to `lines`.
 *
 * @param {LineSet} lines
 */
function takeLateChildLines (lines) {
  if (childDirectory === undefined) return
  const open = new Set()
  for (const owner of openTests) {
    const target = childTargetByOwner.get(owner)
    if (target !== undefined) open.add(path.basename(target))
  }
  readChildLines(name => !open.has(name.slice(0, name.indexOf('-'))), lines)
}

/**
 * @param {(name: string) => boolean} accept
 * @param {LineSet} lines
 */
function readChildLines (accept, lines) {
  const collector = getCollector()
  for (const name of fs.readdirSync(childDirectory)) {
    if (!name.endsWith('.json') || !accept(name)) continue
    const filename = path.join(childDirectory, name)
    try {
      const { files } = JSON.parse(fs.readFileSync(filename, 'utf8'))
      for (const [source, sourceLines] of Object.entries(files)) {
        const file = collector.fileIndex(source)
        for (const line of sourceLines) lines.add(file, line)
      }
    } catch (error) {
      log.debug('Line coverage could not read %s: %s', filename, error.message)
    }
    fs.rmSync(filename, { force: true })
  }
}

/**
 * Starts collecting in a child process started for a test or a suite setup. The child runs on that
 * owner's behalf, so everything it runs is the owner's, initialiser code included. It writes its
 * lines for the parent at exit.
 */
function enableChild () {
  const target = getEnvironmentVariable(CHILD_TARGET)
  const root = getEnvironmentVariable(CHILD_ROOT)
  if (!target || !root || enabled) return
  enable({ root })
  ownTarget = target
  const collector = getCollector()
  const owner = collector.createOwner()
  collector.resolveOwner = () => owner
  collector.initToOwner = true
  process.once('exit', () => writeChildLines(target, owner))
}

/**
 * @param {string} target
 * @param {Owner} owner
 */
function writeChildLines (target, owner) {
  try {
    const collector = getCollector()
    collector.boundary()
    const lines = new LineSet()
    collector.takeLines(owner, lines)
    collector.takeLines(collector.unowned, lines)
    const files = {}
    for (const [file, bitmap] of lines.bitmaps) {
      const fileLines = []
      for (let line = 0; line < bitmap.length * 8; line++) {
        if (bitmap[line >> 3] & (1 << (line & 7))) fileLines.push(line)
      }
      files[collector.filename(file)] = fileLines
    }
    const temporary = `${target}-${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ files }))
    fs.renameSync(temporary, `${target}-${process.pid}.json`)
  } catch (error) {
    log.debug('Line coverage could not write the lines of a child process: %s', error.message)
  }
}

function removeChildDirectory () {
  if (childDirectory !== undefined) fs.rmSync(childDirectory, { recursive: true, force: true })
}

/**
 * @param {LineSet} lines
 * @returns {FileCoverage[]}
 */
function toFiles (lines) {
  const collector = getCollector()
  const files = []
  for (const [file, bitmap] of lines.bitmaps) {
    let end = bitmap.length
    while (end > 0 && bitmap[end - 1] === 0) end--
    if (end === 0) continue
    let filename = relativeFilenames[file]
    if (filename === undefined) {
      filename = path.relative(rootPrefix, collector.filename(file)).split(path.sep).join('/')
      relativeFilenames[file] = filename
    }
    files.push({ filename, bitmap: Buffer.from(bitmap.buffer, bitmap.byteOffset, end) })
  }
  return files
}

// Debugging aid: _DD_LINE_COVERAGE_DUMP=<file> writes every line the process covered at exit.
const dumpPath = getEnvironmentVariable('_DD_LINE_COVERAGE_DUMP')
const testUnion = new LineSet()

function writeDump () {
  const all = new LineSet()
  all.addAll(testUnion)
  for (const { files } of takeShared()) {
    for (const { filename, bitmap } of files) {
      all.addBitmap(getCollector().fileIndex(path.resolve(rootPrefix, filename)), bitmap)
    }
  }
  const files = {}
  for (const [file, bitmap] of all.bitmaps) {
    const lines = []
    for (let line = 0; line < bitmap.length * 8; line++) {
      if (bitmap[line >> 3] & (1 << (line & 7))) lines.push(line)
    }
    if (lines.length > 0) files[getCollector().filename(file)] = lines
  }
  fs.writeFileSync(dumpPath, JSON.stringify({ files }))
}

/**
 * Whether `filename` is a file of the repository: under the root, outside `node_modules` and
 * outside directories whose name starts with a dot.
 *
 * @param {string} filename an absolute path
 */
function shouldInstrument (filename) {
  if (!filename.startsWith(rootPrefix)) return false
  const parts = filename.slice(rootPrefix.length).split(path.sep)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'node_modules' || (i < parts.length - 1 && parts[i].startsWith('.'))) return false
  }
  return true
}

/**
 * @param {string} filename an absolute path, which may go through symbolic links
 * @returns {string | undefined} the real path, when it is a file of the repository
 */
function getRepositoryFile (filename) {
  let real
  try {
    real = fs.realpathSync(filename)
  } catch {
    real = path.resolve(filename)
  }
  return shouldInstrument(real) ? real : undefined
}

let oxc

/**
 * @param {string} code
 * @param {boolean} isModule
 * @returns {object} an ESTree Program
 */
function parse (code, isModule) {
  if (oxc === undefined) {
    try {
      oxc = require('oxc-parser')
    } catch {
      oxc = null
    }
  }
  if (oxc) {
    const { program, errors } = oxc.parseSync('index.js', code, {
      // CommonJS allows a top-level `return`.
      sourceType: isModule ? 'module' : 'commonjs',
      preserveParens: false,
    })
    if (errors.length > 0) throw new Error(errors[0].message)
    return program
  }
  return require('../../../../../vendor/dist/meriyah').parse(code, {
    module: isModule,
    globalReturn: !isModule,
    ranges: true,
  })
}

/**
 * @param {object | string | undefined} sourceMap
 * @returns {object | undefined}
 */
function toSourceMap (sourceMap) {
  if (typeof sourceMap === 'string') {
    try {
      sourceMap = JSON.parse(sourceMap)
    } catch {
      return
    }
  }
  return Array.isArray(sourceMap?.sources) ? sourceMap : undefined
}

/**
 * Returns the instrumented code, or `code` when it cannot be instrumented.
 *
 * @param {string} code
 * @param {string} filename
 * @param {{ isModule?: boolean, reuse?: boolean, sourceMap?: object | string }} [options]
 *   `reuse` keeps the result for the next call with the same filename and code, for frameworks that
 *   compile a module once per test file. `sourceMap` maps `code` back to the files it was compiled
 *   from; without it, a source map the code names in a `sourceMappingURL` comment does. Lines are
 *   then reported in the original files, and code mapped to no line of a repository file is not
 *   probed.
 */
function instrumentSource (code, filename, { isModule = false, reuse = false, sourceMap } = {}) {
  if (reuse) {
    const cached = instrumentedByFilename.get(filename)
    if (cached !== undefined && cached.code === code) return cached.instrumented
    const instrumented = instrumentSource(code, filename, { isModule, sourceMap })
    instrumentedByFilename.set(filename, { code, instrumented })
    return instrumented
  }
  const start = process.hrtime.bigint()
  try {
    const collector = getCollector()
    const map = toSourceMap(sourceMap) ?? readSourceMap(code, filename)
    let mapPosition
    /** @type {number[]} the collector's file index of each source, -1 outside the repository */
    let sourceFiles
    if (map === undefined) {
      sourceFiles = [collector.fileIndex(filename)]
    } else {
      const mapper = createPositionMapper(map, filename)
      sourceFiles = mapper.sources.map(source => {
        const file = getRepositoryFile(source)
        return file === undefined ? -1 : collector.fileIndex(file)
      })
      mapPosition = (line, column) => {
        const original = mapper.mapPosition(line, column)
        return original === undefined || sourceFiles[original.source] === -1 ? undefined : original
      }
    }
    const moduleId = collector.reserveModule()
    const result = instrument(code, { parse: source => parse(source, isModule), moduleId, mapPosition })
    if (!result) return code
    const { slots } = result
    const files = new Int32Array(slots.length)
    const lines = new Int32Array(slots.length)
    for (let i = 0; i < slots.length; i++) {
      files[i] = sourceFiles[slots[i].source]
      lines[i] = slots[i].init ? -slots[i].line : slots[i].line
    }
    collector.defineModule(moduleId, files, lines)
    stats.files++
    stats.bytesIn += code.length
    stats.bytesOut += result.code.length
    return result.code
  } catch (error) {
    stats.failures++
    log.debug('Line coverage could not instrument %s: %s', filename, error.message)
    return code
  } finally {
    stats.instrumentNs += process.hrtime.bigint() - start
  }
}

/**
 * Makes the collector reachable from code that runs with `globalObject` as its global.
 *
 * @param {object} globalObject
 */
function installGlobal (globalObject) {
  getCollector().install(globalObject)
}

/**
 * Starts collecting: instruments CommonJS modules under `root` as they are compiled.
 *
 * @param {{ root: string, patchModuleLoader?: boolean }} options
 *   `patchModuleLoader: false` leaves Node's loader alone, for frameworks that compile repo modules
 *   themselves and call instrumentSource: code they load through Node's own loader (transformers,
 *   configuration files) is not what the tests cover.
 */
function enable ({ root, patchModuleLoader = true }) {
  if (enabled) return
  enabled = true
  const collector = getCollector()
  collector.resolveOwner = resolveOwner
  scheduleResets(collector)
  childProcessChannel.subscribe({ start: onChildProcessStart })
  process.once('exit', removeChildDirectory)
  let realRoot = root
  try {
    realRoot = fs.realpathSync(root)
  } catch {}
  rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  if (patchModuleLoader) {
    const compile = Module.prototype._compile
    Module.prototype._compile = function (content, filename, ...rest) {
      if (typeof content === 'string' && shouldInstrument(filename)) {
        content = instrumentSource(content, filename)
      }
      return compile.call(this, content, filename, ...rest)
    }
  }
  if (dumpPath) process.once('exit', writeDump)
  if (getEnvironmentVariable('_DD_LINE_COVERAGE_STATS')) {
    process.once('exit', () => {
      const c = getCollector().stats
      // eslint-disable-next-line no-console
      console.error('[line-coverage]', JSON.stringify({
        files: stats.files,
        failures: stats.failures,
        instrumentMs: Number(stats.instrumentNs / 1000n) / 1000,
        bytesIn: stats.bytesIn,
        bytesOut: stats.bytesOut,
        resets: c.resets,
        touches: c.touches,
        switches: c.switches,
        readerCalls: c.readerCalls,
      }))
    })
  }
}

/**
 * Makes the collector reset when a macrotask starts: what runs from then on may run in another
 * context. Where async hooks can leave promises out, a `before` hook does it, at no cost to promise
 * jobs. Elsewhere a microtask queued after the first touch since the last reset does it, since the
 * microtask queue drains before the next macrotask.
 *
 * @param {import('./collector').LineCoverageCollector} collector
 */
function scheduleResets (collector) {
  const reset = () => {
    try {
      collector.reset()
    } catch (error) {
      log.debug('Line coverage could not reset: %s', error.message)
    }
  }
  const mode = getEnvironmentVariable('_DD_LINE_COVERAGE_RESET')
  const asyncHooks = require('node:async_hooks')
  if (mode !== 'microtask' && canLeavePromisesOut(asyncHooks)) {
    asyncHooks.createHook({ before: reset, trackPromises: false }).enable()
    if (mode !== 'both') return
  }
  collector.setResetScheduler(() => queueMicrotask(reset))
}

/**
 * Whether `createHook` honours `trackPromises: false`. Runtimes that do refuse it together with a
 * `promiseResolve` callback; the others ignore it and would track promises anyway.
 *
 * @param {typeof import('node:async_hooks')} asyncHooks
 */
function canLeavePromisesOut (asyncHooks) {
  try {
    asyncHooks.createHook({ promiseResolve () {}, trackPromises: false })
    return false
  } catch {
    return true
  }
}

module.exports = {
  enable,
  enableChild,
  finishSuiteSetup,
  finishTest,
  getCollector,
  installGlobal,
  instrumentSource,
  isActive,
  isEnabled,
  shouldInstrument,
  startSuiteSetup,
  startTest,
  suiteSetupStore,
  takeShared,
}
