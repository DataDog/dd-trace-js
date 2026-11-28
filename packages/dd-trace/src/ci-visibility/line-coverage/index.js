'use strict'

// Per-test line coverage: what each test executed, as defined for the accuracy checker.
//
//   Cov(test) = own lines ∪ fixture lines ∪ initialiser lines
//
// Own lines ran inside the test's window, which opens before its per-test hooks and closes after
// them. Fixture lines ran in a suite-scope setup hook (beforeAll) of a suite enclosing the test.
// Initialiser lines (module top level, static members of classes defined there) never belong to a
// window: every test that ran other lines of a file gets the initialiser lines of that file.
// Everything that ran outside test windows is reported once per process as Shared, in three parts:
// initialiser lines, suite setup lines, and the rest (unowned).
//
// A framework integration calls, in each process that runs tests:
//   enable({ root })                    once; instruments CommonJS modules under root as they load
//   instrumentSource(code, filename, options)  for modules the framework compiles itself
//   installGlobal(globalObject)         for every other realm instrumented code runs in
//   startTest() / finishTest(test, suites)
//   startSuiteSetup(suite) / finishSuiteSetup()
//   takeShared()                        after the last test, or after each test file

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { getEnvironmentVariable } = require('../../config/helper')
const log = require('../../log')
const compiler = require('../../../../datadog-instrumentations/src/helpers/rewriter/compiler')
const { getCollector, LineSet } = require('./collector')
const { instrument } = require('./instrument')

const EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx'])

/**
 * @typedef {{ filename: string, bitmap: Buffer }} FileCoverage
 * @typedef {{ lines: LineSet }} TestCoverage
 */

let enabled = false
let rootPrefix = ''
const stats = { files: 0, instrumentNs: 0n, failures: 0, bytesIn: 0, bytesOut: 0 }

let unowned = new LineSet()
let suiteSetup = new LineSet()

/** @type {WeakMap<object, LineSet>} lines of each suite's setup hooks */
const fixtures = new WeakMap()

/** @type {Set<TestCoverage>} */
const openTests = new Set()

/** @type {{ suite: object, lines: LineSet } | undefined} */
let openSetup

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

// Lines go to the one open window. Overlapping windows are concurrent tests, which are not
// attributed yet: what runs while they overlap goes to Shared.
function currentTarget () {
  const open = openTests.size + (openSetup ? 1 : 0)
  if (open !== 1) return unowned
  if (openSetup) return openSetup.lines
  return openTests.values().next().value.lines
}

function closeSetup () {
  if (!openSetup) return
  getCollector().take(currentTarget())
  const { suite, lines } = openSetup
  openSetup = undefined
  let fixture = fixtures.get(suite)
  if (fixture === undefined) {
    fixture = new LineSet()
    fixtures.set(suite, fixture)
  }
  fixture.addAll(lines)
  suiteSetup.addAll(lines)
}

/**
 * Opens a test's window. Call it when the framework starts the test, before per-test hooks.
 *
 * @returns {TestCoverage}
 */
function startTest () {
  closeSetup()
  getCollector().take(currentTarget())
  const test = { lines: new LineSet() }
  openTests.add(test)
  return test
}

/**
 * Closes a test's window, after its per-test hooks, and returns its coverage.
 *
 * @param {TestCoverage} test
 * @param {Iterable<object>} [suites] the suites enclosing the test, as passed to startSuiteSetup
 * @returns {FileCoverage[]}
 */
function finishTest (test, suites) {
  if (!openTests.has(test)) return []
  const collector = getCollector()
  collector.take(currentTarget())
  openTests.delete(test)
  const coverage = test.lines
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
 * every test that passes `suite` to finishTest.
 *
 * @param {object} suite
 */
function startSuiteSetup (suite) {
  closeSetup()
  getCollector().take(currentTarget())
  openSetup = { suite, lines: new LineSet() }
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
  collector.take(currentTarget())
  const shared = [
    { shared: 'init', files: toFiles(collector.sharedInit) },
    { shared: 'suiteSetup', files: toFiles(suiteSetup) },
    { shared: 'unowned', files: toFiles(unowned) },
  ]
  collector.sharedInit = new LineSet()
  suiteSetup = new LineSet()
  unowned = new LineSet()
  return shared
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
 * @param {string} filename
 */
function shouldInstrument (filename) {
  if (!filename.startsWith(rootPrefix)) return false
  const relative = filename.slice(rootPrefix.length)
  if (relative.startsWith('.') || relative.includes(`${path.sep}.`) ||
    relative.startsWith(`node_modules${path.sep}`) || relative.includes(`${path.sep}node_modules${path.sep}`)) {
    return false
  }
  return EXTENSIONS.has(path.extname(filename))
}

/**
 * Returns the instrumented code, or `code` when it cannot be instrumented.
 *
 * @param {string} code
 * @param {string} filename
 * @param {{ isModule?: boolean, reuse?: boolean, sourceMap?: object | string }} [options]
 *   `reuse` keeps the result for the next call with the same filename and code, for frameworks that
 *   compile a module once per test file. `sourceMap` maps `code` back to the file on disk: lines are
 *   reported in the original file, and code mapped to no line of it is not probed.
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
    const result = instrument(code, {
      parse: (source, sourceIsModule) => compiler.parse(source, { isModule: sourceIsModule, range: true }),
      isModule,
      fileIndex: getCollector().fileIndex(filename),
      originalLine: sourceMap ? getOriginalLine(sourceMap) : undefined,
    })
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
    stats.instrumentNs += process.hrtime.bigint() - start
  }
}

/**
 * @param {object | string} sourceMap
 * @returns {(line: number, column: number) => number}
 */
function getOriginalLine (sourceMap) {
  const { SourceMapConsumer } = require('../../../../../vendor/dist/@datadog/source-map')
  const consumer = new SourceMapConsumer(typeof sourceMap === 'string' ? JSON.parse(sourceMap) : sourceMap)
  // A file transformed on its own maps to a single source; lines of other sources are not this file's.
  const source = consumer.sources.length === 1 ? consumer.sources[0] : null
  return (line, column) => {
    const position = consumer.originalPositionFor({ line, column })
    return position.line !== null && position.source === source ? position.line : 0
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
 * @param {{ root: string }} options
 */
function enable ({ root }) {
  if (enabled) return
  enabled = true
  getCollector()
  let realRoot = root
  try {
    realRoot = fs.realpathSync(root)
  } catch {}
  rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
  const compile = Module.prototype._compile
  Module.prototype._compile = function (content, filename, ...rest) {
    if (typeof content === 'string' && shouldInstrument(filename)) {
      content = instrumentSource(content, filename)
    }
    return compile.call(this, content, filename, ...rest)
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
        boundaries: c.boundaries,
        readerCalls: c.readerCalls,
        lines: c.lines,
        takeMs: Number(c.takeNs / 1000n) / 1000,
      }))
    })
  }
}

module.exports = {
  enable,
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
  takeShared,
}
