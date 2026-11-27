'use strict'

// Per-test line coverage: what each test executed, as defined for the accuracy checker.
//
//   Cov(test) = own lines ∪ fixture lines ∪ initialiser lines
//
// Own lines ran inside the test's window, in a context that carries the test. The window opens
// before the test's per-test hooks and closes after them. A context carries the test when dd-trace's
// active span belongs to the test's trace: the test's own context, everything started from it, and
// requests handled for it in the same process when trace context reaches them. Child processes and
// worker threads started for the test, and messages posted to workers for it, carry it too (see
// worker-threads.js). Fixture lines ran in a suite-scope setup hook (beforeAll) of a suite enclosing
// the test, in a context opened for that hook, while it ran. Initialiser lines (module top level,
// static members of classes defined there) belong to no window: every test that ran other lines of a
// file gets the initialiser lines of that file. Everything else is reported once per process as
// Shared, in three parts: initialiser lines, suite setup lines, and the rest (unowned): what ran
// outside every window, in a context that carries no open window, or in one whose window had closed.
//
// A framework integration calls, in each process that runs tests:
//   enable({ root })                    once; instruments CommonJS modules under root as they load
//   instrumentSource(code, filename, options)  for modules the framework compiles itself
//   installGlobal(globalObject)         for every other realm instrumented code runs in
//   startTest(span) / finishTest(test, suites)
//   startSuiteSetup(suite) / finishSuiteSetup(), and runs each suite setup hook in suiteSetupStore()
//   takeShared()                        after the last test, or after each test file

// Functions that tests replace (fake timers, fs mocks, stubs) are taken before any test runs. What
// runs for each test calls no path function, since path functions call each other through the module.
// A mock that replaces the fs binding, like mock-fs, still reaches these functions, as it reaches
// the test framework's own module loading; what fails to read or write is then skipped.
const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } =
  require('node:fs')
const Module = require('node:module')
const { tmpdir } = require('node:os')
const { dirname, join, relative, resolve, sep } = require('node:path')
const { threadId } = require('node:worker_threads')

const dc = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const { addChildProcessEnv } = require('../../child-process-env')
const { getEnvironmentVariable } = require('../../config/helper')
const log = require('../../log')
const { getCollector, LineSet } = require('./collector')
const { instrument } = require('./instrument')
const { createPositionMapper, getSourceMappingUrl, readSourceMapUrl } = require('./source-map')
const { followWorkers, getParentSettings, reportToParent } = require('./worker-threads')

/**
 * @typedef {{ filename: string, bitmap: Buffer }} FileCoverage
 * @typedef {import('./collector').Owner} Owner
 * @typedef {import('./worker-threads').PathLines} PathLines
 */

const legacyStorage = storage('legacy')

const { queueMicrotask } = globalThis
const hrtime = process.hrtime.bigint

// Marks a context opened on an owner's behalf: a suite setup hook, or a message for a worker
// thread. Stores derived from it keep the mark, with the trace of the span it was set on: a span of
// another trace, continued from propagated headers, can still carry a test.
const OWNER = Symbol('dd-trace.line-coverage.owner')
const MARKED_TRACE = Symbol('dd-trace.line-coverage.marked-trace')

// A child process started for a test (or suite setup) gets these variables. It counts everything it
// runs as that owner's and, at exit, writes it to `<target>-<pid>.json`.
const CHILD_TARGET = '_DD_LINE_COVERAGE_CHILD'
const CHILD_ROOT = '_DD_LINE_COVERAGE_ROOT'

let enabled = false
let rootPrefix = ''
const stats = { files: 0, instrumentNs: 0n, failures: 0, bytesIn: 0, bytesOut: 0, cacheHits: 0, cacheWrites: 0 }

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

/** @type {Map<Owner, LineSet>} what worker threads ran for each owner, not taken yet */
const workerLines = new Map()

/** @type {import('./worker-threads').Pending} */
const NOTHING_PENDING = { owned: [] }

const NO_STORE = {}
let cachedStore = NO_STORE
/** @type {Owner | undefined} */
let cachedOwner

/** @type {string[]} filenames relative to the root, by file index */
const relativeFilenames = []

/** @type {Map<string, { code: string, instrumented: string }>} */
const instrumentedByFilename = new Map()

/** Keys of code instrumented for this thread only. */
let nextModuleKey = 0

/** @type {string | null | undefined} what cached code depends on besides its input; null without a cache */
let cacheSalt
let isOxcInCacheSalt = false

/** @type {Set<string>} cache directories known to exist */
const cacheDirectories = new Set()

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
  const { unowned } = getCollector()
  if (!store) return unowned
  const marked = store[OWNER]
  const context = typeof store.span?.context === 'function' ? store.span.context() : undefined
  // Spans started under the mark belong to the trace it was set on.
  if (marked !== undefined && context?._trace === store[MARKED_TRACE]) return marked.open ? marked : unowned
  let owner
  if (context?._trace) owner = ownerByTrace.get(context._trace)
  if (owner === undefined && ownerByTraceId.size > 0 && context?._traceId) {
    owner = ownerByTraceId.get(context._traceId.toString(16))
  }
  if (owner?.open) return owner
  return marked?.open ? marked : unowned
}

/**
 * @template {object} T
 * @param {T | undefined} store
 * @param {Owner} owner
 * @returns {T}
 */
function markStore (store, owner) {
  const span = /** @type {{ span?: { context?: () => { _trace?: object } } } | undefined} */ (store)?.span
  const trace = typeof span?.context === 'function' ? span.context()?._trace : undefined
  return /** @type {T} */ ({ ...store, [OWNER]: owner, [MARKED_TRACE]: trace })
}

/**
 * @param {Owner} owner
 * @param {() => unknown} fn
 */
function runAs (owner, fn) {
  return legacyStorage.run(markStore(legacyStorage.getStore(), owner), fn)
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
  takeWorkerLines(owner, lines)
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
  takeWorkerLines(test, coverage)
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
  return markStore(store, openSetup.owner)
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
  takeWorkerLines(collector.unowned, unownedLines)
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
    childDirectory ??= mkdtempSync(`${tmpdir()}${sep}dd-line-coverage-`)
    target = `${childDirectory}${sep}${++childTargets}`
    childTargetByOwner.set(owner, target)
  }
  return target
}

/**
 * @param {string} target a target in the child directory
 */
function getTargetName (target) {
  return target.slice(childDirectory.length + sep.length)
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
  const prefix = `${getTargetName(target)}-`
  readChildLines(name => name.startsWith(prefix), lines)
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
    if (target !== undefined) open.add(getTargetName(target))
  }
  readChildLines(name => !open.has(name.slice(0, name.indexOf('-'))), lines)
}

/**
 * @param {(name: string) => boolean} accept
 * @param {LineSet} lines
 */
function readChildLines (accept, lines) {
  let names
  try {
    names = readdirSync(childDirectory)
  } catch (error) {
    log.debug('Line coverage could not read %s: %s', childDirectory, error.message)
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json') || !accept(name)) continue
    const filename = `${childDirectory}${sep}${name}`
    try {
      addPathLines(lines, JSON.parse(readFileSync(filename, 'utf8')).files)
    } catch (error) {
      log.debug('Line coverage could not read %s: %s', filename, error.message)
    }
    try {
      rmSync(filename, { force: true })
    } catch (error) {
      log.debug('Line coverage could not remove %s: %s', filename, error.message)
    }
  }
}

/**
 * @param {LineSet} lines
 * @param {PathLines | undefined} files
 */
function addPathLines (lines, files) {
  if (files === undefined) return
  const collector = getCollector()
  for (const source of Object.keys(files)) {
    const file = collector.fileIndex(source)
    for (const line of files[source]) lines.add(file, line)
  }
}

/**
 * @param {LineSet} lines
 * @returns {PathLines | undefined} undefined when there are no lines
 */
function toPathLines (lines) {
  const collector = getCollector()
  let files
  for (const [file, bitmap] of lines.bitmaps) {
    const fileLines = []
    for (let line = 0; line < bitmap.length * 8; line++) {
      if (bitmap[line >> 3] & (1 << (line & 7))) fileLines.push(line)
    }
    if (fileLines.length === 0) continue
    files ??= {}
    files[collector.filename(file)] = fileLines
  }
  return files
}

/**
 * Records lines a worker thread ran for `owner`. Lines for no owner, or for one whose window has
 * closed, are unowned.
 *
 * @param {Owner | undefined} owner
 * @param {PathLines | undefined} files
 */
function receiveWorkerLines (owner, files) {
  if (files === undefined) return
  const collector = getCollector()
  if (owner === undefined || !owner.open) owner = collector.unowned
  let lines = workerLines.get(owner)
  if (lines === undefined) {
    lines = new LineSet()
    workerLines.set(owner, lines)
  }
  addPathLines(lines, files)
}

/**
 * @param {PathLines | undefined} files
 */
function receiveWorkerInit (files) {
  if (files === undefined) return
  const collector = getCollector()
  addPathLines(collector.init, files)
  addPathLines(collector.sharedInit, files)
}

/**
 * @param {Owner} owner
 * @param {LineSet} target
 */
function takeWorkerLines (owner, target) {
  const lines = workerLines.get(owner)
  if (lines === undefined) return
  workerLines.delete(owner)
  target.addAll(lines)
}

/**
 * What ran in this worker since the last report: per owner, unowned, and initialiser lines.
 *
 * @returns {import('./worker-threads').Pending}
 */
function takeWorkerReport () {
  const collector = getCollector()
  collector.boundary()
  if (collector.ownersWithLines.size === 0 && workerLines.size === 0 && collector.sharedInit.bitmaps.size === 0) {
    return NOTHING_PENDING
  }
  const { unowned } = collector
  /** @type {Map<Owner, LineSet>} */
  const byOwner = new Map()
  for (const owner of collector.ownersWithLines) {
    if (owner === unowned) continue
    const lines = new LineSet()
    collector.takeLines(owner, lines)
    byOwner.set(owner, lines)
  }
  for (const [owner, lines] of workerLines) {
    if (owner === unowned) continue
    const ownerLines = byOwner.get(owner)
    if (ownerLines === undefined) byOwner.set(owner, lines)
    else ownerLines.addAll(lines)
    workerLines.delete(owner)
  }
  const unownedLines = new LineSet()
  collector.takeLines(unowned, unownedLines)
  takeWorkerLines(unowned, unownedLines)
  const init = collector.sharedInit
  collector.sharedInit = new LineSet()
  /** @type {Array<[Owner, PathLines]>} */
  const owned = []
  for (const [owner, lines] of byOwner) {
    const files = toPathLines(lines)
    if (files !== undefined) owned.push([owner, files])
  }
  return { owned, unowned: toPathLines(unownedLines), init: toPathLines(init) }
}

const workerHost = {
  resolveOwner,
  createOwner: () => getCollector().createOwner(),
  unowned: () => getCollector().unowned,
  runAs,
  receive: receiveWorkerLines,
  receiveInit: receiveWorkerInit,
  takePending: takeWorkerReport,
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
    takeWorkerLines(owner, lines)
    takeWorkerLines(collector.unowned, lines)
    // A worker thread of the child that writes for itself shares the child's process id.
    const writer = threadId === 0 ? String(process.pid) : `${process.pid}.${threadId}`
    const temporary = `${target}-${writer}.tmp`
    // The parent may have created the directory while a test replaced the fs binding.
    mkdirSync(target.slice(0, target.lastIndexOf(sep)), { recursive: true })
    writeFileSync(temporary, JSON.stringify({ files: toPathLines(lines) }))
    renameSync(temporary, `${target}-${writer}.json`)
  } catch (error) {
    log.debug('Line coverage could not write the lines of a child process: %s', error.message)
  }
}

function removeChildDirectory () {
  if (childDirectory === undefined) return
  try {
    rmSync(childDirectory, { recursive: true, force: true })
  } catch (error) {
    log.debug('Line coverage could not remove %s: %s', childDirectory, error.message)
  }
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
      filename = collector.filename(file)
      filename = filename.startsWith(rootPrefix) ? filename.slice(rootPrefix.length) : relative(rootPrefix, filename)
      if (sep !== '/') filename = filename.split(sep).join('/')
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
      all.addBitmap(getCollector().fileIndex(resolve(rootPrefix, filename)), bitmap)
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
  writeFileSync(dumpPath, JSON.stringify({ files }))
}

/**
 * Whether `filename` is a file of the repository: under the root, outside `node_modules` and
 * outside directories whose name starts with a dot.
 *
 * @param {string} filename an absolute path
 */
function shouldInstrument (filename) {
  if (!filename.startsWith(rootPrefix)) return false
  const parts = filename.slice(rootPrefix.length).split(sep)
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
    real = realpathSync(filename)
  } catch {
    real = resolve(filename)
  }
  return shouldInstrument(real) ? real : undefined
}

/**
 * @typedef {(code: string, options: { sourceType: string, preserveParens: boolean }) => object} OxcParse
 *   returns an ESTree Program, and throws on a syntax error
 */

/** @type {OxcParse | null | undefined} */
let oxcParse

/** @returns {OxcParse | null} null when oxc-parser cannot be loaded */
function getOxcParse () {
  if (oxcParse === undefined) {
    oxcParse = loadOxcBinding() ?? loadOxcPackage() ?? null
    // What meriyah parses instead is not cached under a salt that names oxc.
    if (oxcParse === null && isOxcInCacheSalt) cacheSalt = null
  }
  return oxcParse
}

/**
 * oxc-parser's own entry is an ES module that also loads its visitor and raw transfer support. In a
 * process that instruments a few files, loading it costs more than the parsing, and twice what
 * loading the native binding it picks costs. The binding parses on its own.
 *
 * @returns {OxcParse | undefined} undefined where the binding cannot be picked as oxc-parser picks it
 */
function loadOxcBinding () {
  const target = getOxcBindingTarget()
  if (target === undefined) return
  let binding
  try {
    const oxcDirectory = dirname(require.resolve('oxc-parser/package.json'))
    binding = require(require.resolve(`@oxc-parser/binding-${target}`, { paths: [oxcDirectory] }))
  } catch {
    return
  }
  const parseWithBinding = (code, options) => {
    const { program, errors } = binding.parseSync('index.js', code, options)
    if (errors.length > 0) throw new Error(errors[0].message)
    // The JSON leaves out the values of BigInt and RegExp literals, which instrumenting does not read.
    return JSON.parse(program).node
  }
  // The binding is not oxc-parser's API: a release that changes what it returns gets the package.
  try {
    if (parseWithBinding('0', { sourceType: 'commonjs', preserveParens: false }).type === 'Program') {
      return parseWithBinding
    }
  } catch {}
}

/**
 * @returns {string | undefined} the platform part of the name of oxc-parser's binding package, where
 *   oxc-parser picks it from the platform alone
 */
function getOxcBindingTarget () {
  const { platform, arch } = process
  if (arch !== 'x64' && arch !== 'arm64') return
  if (getEnvironmentVariable('NAPI_RS_NATIVE_LIBRARY_PATH')) return
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform !== 'linux') return
  // How oxc-parser tells musl from glibc first.
  let ldd
  try {
    ldd = readFileSync('/usr/bin/ldd', 'utf8')
  } catch {
    return
  }
  return `linux-${arch}-${ldd.includes('musl') ? 'musl' : 'gnu'}`
}

/** @returns {OxcParse | undefined} */
function loadOxcPackage () {
  let oxc
  try {
    oxc = require('oxc-parser')
  } catch {
    return
  }
  return (code, options) => {
    const { program, errors } = oxc.parseSync('index.js', code, options)
    if (errors.length > 0) throw new Error(errors[0].message)
    return program
  }
}

/**
 * @param {string} code
 * @param {boolean} isModule
 * @returns {object} an ESTree Program
 */
function parse (code, isModule) {
  const parseWithOxc = getOxcParse()
  if (parseWithOxc !== null) {
    // CommonJS allows a top-level `return`.
    return parseWithOxc(code, { sourceType: isModule ? 'module' : 'commonjs', preserveParens: false })
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
 * What instrumented code depends on besides its input: the code that instruments it and the code it
 * calls, and the parser.
 *
 * @returns {string | null} null when it cannot be known, and nothing is cached
 */
function getCacheSalt () {
  if (cacheSalt !== undefined) return cacheSalt
  try {
    const hash = createHash('sha1')
    for (const file of ['./index', './collector', './instrument', './source-map']) {
      hash.update(readFileSync(require.resolve(file)))
    }
    // The parser is named from its package rather than loaded: when every module comes from the
    // cache, nothing is parsed.
    let parser = 'meriyah'
    if (oxcParse !== null) {
      try {
        parser = `oxc-parser ${require('oxc-parser/package.json').version}`
        isOxcInCacheSalt = true
      } catch {}
    }
    hash.update(parser)
    cacheSalt = hash.digest('hex')
  } catch {
    cacheSalt = null
  }
  return cacheSalt
}

/**
 * @param {string} directory
 * @param {string} key
 */
function getCachePath (directory, key) {
  return join(directory, 'dd-trace-line-coverage', key.slice(0, 2), key)
}

/**
 * @param {string} directory
 * @param {string} key
 * @returns {string | undefined} the instrumented code, empty for code that is not instrumented, or
 *   undefined when the cache does not have it
 */
function readCachedCode (directory, key) {
  let text
  try {
    text = readFileSync(getCachePath(directory, key), 'utf8')
  } catch {
    return
  }
  // A cache file starts with `<key>:<length of the code>\n`.
  const newline = text.indexOf('\n')
  if (newline === -1 || !text.startsWith(`${key}:`)) return
  const code = text.slice(newline + 1)
  if (Number(text.slice(key.length + 1, newline)) === code.length) return code
}

/**
 * @param {string} directory
 * @param {string} key
 * @param {string} code the instrumented code, empty for code that is not instrumented
 */
function writeCachedCode (directory, key, code) {
  const file = getCachePath(directory, key)
  const temporary = `${file}.${process.pid}-${threadId}`
  try {
    const parent = dirname(file)
    if (!cacheDirectories.has(parent)) {
      mkdirSync(parent, { recursive: true })
      cacheDirectories.add(parent)
    }
    // Readers in other processes see the whole file or none.
    writeFileSync(temporary, `${key}:${code.length}\n${code}`)
    renameSync(temporary, file)
    stats.cacheWrites++
  } catch (error) {
    log.debug('Line coverage could not cache %s: %s', file, error.message)
    try {
      rmSync(temporary, { force: true })
    } catch {}
  }
}

/**
 * The key of instrumented code in a cache shared with other processes: a hash of everything the
 * code depends on.
 *
 * @param {string} salt
 * @param {string} code
 * @param {string} filename
 * @param {boolean} isModule
 * @param {object | string | undefined} sourceMap
 */
function getCacheKey (salt, code, filename, isModule, sourceMap) {
  return createHash('sha1')
    .update(`${salt}\0${rootPrefix}\0${filename}\0${isModule}\0`)
    .update(typeof sourceMap === 'string' ? sourceMap : JSON.stringify(sourceMap ?? null))
    .update('\0')
    .update(code)
    .digest('hex')
}

/**
 * Returns the instrumented code, or `code` when it cannot be instrumented.
 *
 * @param {string} code
 * @param {string} filename
 * @param {object} [options]
 * @param {boolean} [options.isModule]
 * @param {boolean} [options.reuse] keeps the result for the next call with the same filename and
 *   code, for frameworks that compile a module once per test file
 * @param {object | string | (() => object | string | undefined)} [options.sourceMap] maps `code` back
 *   to the files it was compiled from, or returns what does, and is then called only when the code
 *   is not reused. Without it, a source map the code names in a `sourceMappingURL` comment does.
 *   Lines are then reported in the original files, and code mapped to no line of a repository file
 *   is not probed.
 * @param {string} [options.cacheDirectory] a directory to keep instrumented code in, for other
 *   processes that instrument the same code
 */
function instrumentSource (code, filename, { isModule = false, reuse = false, sourceMap, cacheDirectory } = {}) {
  if (reuse) {
    const cached = instrumentedByFilename.get(filename)
    if (cached !== undefined && cached.code === code) return cached.instrumented
    const instrumented = instrumentSource(code, filename, { isModule, sourceMap, cacheDirectory })
    instrumentedByFilename.set(filename, { code, instrumented })
    return instrumented
  }
  const start = hrtime()
  try {
    if (typeof sourceMap === 'function') sourceMap = sourceMap()
    let url
    if (sourceMap === undefined) {
      url = getSourceMappingUrl(code)
      // An inline map is part of the code, and is decoded only when the code is instrumented.
      if (url !== undefined && !url.startsWith('data:')) sourceMap = readSourceMapUrl(url, filename)
    }
    const salt = cacheDirectory === undefined ? null : getCacheSalt()
    let key
    if (salt === null) {
      key = String(nextModuleKey++)
    } else {
      key = getCacheKey(salt, code, filename, isModule, sourceMap)
      const cached = readCachedCode(cacheDirectory, key)
      if (cached !== undefined) {
        stats.cacheHits++
        return cached === '' ? code : cached
      }
    }
    if (sourceMap === undefined && url !== undefined) sourceMap = readSourceMapUrl(url, filename)
    const map = toSourceMap(sourceMap)
    let sources = [filename]
    let mapPosition
    if (map !== undefined) {
      const mapper = createPositionMapper(map, filename)
      sources = mapper.sources.map(source => getRepositoryFile(source) ?? null)
      mapPosition = (line, column) => {
        const original = mapper.mapPosition(line, column)
        return original === undefined || sources[original.source] === null ? undefined : original
      }
    }
    const result = instrument(code, {
      parse: source => parse(source, isModule),
      moduleKey: key,
      sources,
      mapPosition,
    })
    // The salt is dropped when the parser it names fails to load.
    if (salt !== null && cacheSalt !== null) writeCachedCode(cacheDirectory, key, result ? result.code : '')
    if (!result) return code
    stats.files++
    stats.bytesIn += code.length
    stats.bytesOut += result.code.length
    return result.code
  } catch (error) {
    stats.failures++
    log.debug('Line coverage could not instrument %s: %s', filename, error.message)
    return code
  } finally {
    stats.instrumentNs += hrtime() - start
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
  startCollecting(root, patchModuleLoader)
  childProcessChannel.subscribe({ start: onChildProcessStart })
  process.once('exit', removeChildDirectory)
  followWorkers(workerHost, rootPrefix)
}

/**
 * Starts collecting in a worker thread started by a thread that collects: what runs for each
 * message of that thread is reported to it, for the owner of the context that posted the message.
 */
function enableWorker () {
  const settings = getParentSettings()
  if (settings === undefined || enabled) return
  startCollecting(settings.root, true)
  reportToParent(workerHost, settings)
  followWorkers(workerHost, rootPrefix)
}

/**
 * @param {string} root
 * @param {boolean} patchModuleLoader
 */
function startCollecting (root, patchModuleLoader) {
  enabled = true
  const collector = getCollector()
  collector.resolveOwner = resolveOwner
  scheduleResets(collector)
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {}
  rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
  if (patchModuleLoader) {
    const compile = Module.prototype._compile
    Module.prototype._compile = function (content, filename, ...rest) {
      if (typeof content === 'string' && shouldInstrument(filename)) {
        content = instrumentSource(content, filename)
      }
      return compile.call(this, content, filename, ...rest)
    }
  }
  // A worker thread reports to its parent, which writes the dump.
  if (dumpPath && threadId === 0) process.once('exit', writeDump)
  if (getEnvironmentVariable('_DD_LINE_COVERAGE_STATS')) {
    process.once('exit', () => {
      const c = getCollector().stats
      // eslint-disable-next-line no-console
      console.error('[line-coverage]', JSON.stringify({
        files: stats.files,
        failures: stats.failures,
        instrumentMs: Number(stats.instrumentNs / 1000n) / 1000,
        cacheHits: stats.cacheHits,
        cacheWrites: stats.cacheWrites,
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
  enableWorker,
  finishSuiteSetup,
  finishTest,
  getCollector,
  installGlobal,
  instrumentSource,
  isActive,
  shouldInstrument,
  startSuiteSetup,
  startTest,
  suiteSetupStore,
  takeShared,
}
