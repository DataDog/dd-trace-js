'use strict'

const Module = require('node:module')
const path = require('node:path')

const log = require('../../log')
const { getCollector } = require('./collector')
const { instrument } = require('./instrument')

const EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx'])

let parse
let enabled = false
const stats = { files: 0, instrumentNs: 0n, failures: 0, bytesIn: 0, bytesOut: 0 }

/** @type {Map<string, Buffer>} lines that ran outside every test window, by absolute filename */
const shared = new Map()

/** @type {Map<string, string>} */
const relativeFilenames = new Map()

function isEnabled () {
  return process.env.DD_TEST_LINE_COVERAGE_ENABLED === 'true' || process.env.DD_TEST_LINE_COVERAGE_ENABLED === '1'
}

function isActive () {
  return enabled
}

/**
 * Marks the start of a test window. What ran since the previous boundary belongs to no test.
 */
function startTest () {
  mergeInto(shared, getCollector().take())
}

/**
 * @param {Map<string, Buffer>} target
 * @param {Array<{ filename: string, bitmap: Buffer }>} files
 */
function mergeInto (target, files) {
  for (const { filename, bitmap } of files) {
    const existing = target.get(filename)
    if (existing === undefined) {
      target.set(filename, Buffer.from(bitmap))
    } else if (existing.length >= bitmap.length) {
      for (let i = 0; i < bitmap.length; i++) existing[i] |= bitmap[i]
    } else {
      const larger = Buffer.from(bitmap)
      for (let i = 0; i < existing.length; i++) larger[i] |= existing[i]
      target.set(filename, larger)
    }
  }
}

// Debugging aid: DD_LINE_COVERAGE_DUMP=<file> writes every line the process covered at exit.
const dumpPath = process.env.DD_LINE_COVERAGE_DUMP
/** @type {Map<string, Buffer>} */
const testUnion = new Map()

function writeDump () {
  mergeInto(testUnion, getCollector().take())
  mergeInto(testUnion, [...shared].map(([filename, bitmap]) => ({ filename, bitmap })))
  const files = {}
  for (const [filename, bitmap] of testUnion) {
    const lines = []
    for (let line = 0; line < bitmap.length * 8; line++) {
      if (bitmap[line >> 3] & (1 << (line & 7))) lines.push(line)
    }
    files[filename] = lines
  }
  require('node:fs').writeFileSync(dumpPath, JSON.stringify({ files }))
}

/**
 * Marks the end of a test window and returns the lines that ran in it.
 *
 * @param {string} root directory the returned filenames are relative to
 * @returns {Array<{ filename: string, bitmap: Buffer }>}
 */
function finishTest (root) {
  const files = getCollector().take()
  if (dumpPath) mergeInto(testUnion, files)
  for (const file of files) {
    let relative = relativeFilenames.get(file.filename)
    if (relative === undefined) {
      relative = path.relative(root, file.filename)
      relativeFilenames.set(file.filename, relative)
    }
    file.filename = relative
  }
  return files
}

function getParse () {
  if (!parse) {
    const oxc = require(process.env.DD_LINE_COVERAGE_OXC_PATH || 'oxc-parser')
    parse = (code, isModule) => {
      const { program, errors } = oxc.parseSync('file.js', code, {
        sourceType: isModule ? 'module' : 'script',
        preserveParens: false,
      })
      if (errors.length > 0) throw new SyntaxError(errors[0].message)
      return program
    }
  }
  return parse
}

/**
 * @param {string} filename
 * @param {string} root
 * @returns {boolean}
 */
function shouldInstrument (filename, root) {
  if (!filename.startsWith(root)) return false
  if (filename.includes(`${path.sep}node_modules${path.sep}`)) return false
  return EXTENSIONS.has(path.extname(filename))
}

/**
 * @param {string} code
 * @param {string} filename
 * @param {boolean} isModule
 * @returns {string} the instrumented code, or `code` when it cannot be instrumented
 */
function instrumentSource (code, filename, isModule) {
  const start = process.hrtime.bigint()
  try {
    const result = instrument(code, {
      parse: getParse(),
      isModule,
      fileIndex: getCollector().fileIndex(filename),
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
 * Instruments CommonJS modules under `root` as they are compiled.
 *
 * @param {{ root: string }} options
 */
function enable ({ root }) {
  if (enabled) return
  enabled = true
  getCollector()
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep
  const compile = Module.prototype._compile
  Module.prototype._compile = function (content, filename, ...rest) {
    if (typeof content === 'string' && shouldInstrument(filename, rootPrefix)) {
      content = instrumentSource(content, filename, false)
    }
    return compile.call(this, content, filename, ...rest)
  }
  if (dumpPath) process.on('exit', writeDump)
  if (process.env.DD_LINE_COVERAGE_STATS) {
    process.on('exit', () => {
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
        sharedFiles: shared.size,
      }))
    })
  }
}

module.exports = { enable, finishTest, getCollector, instrumentSource, isActive, isEnabled, startTest }
