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
      }))
    })
  }
}

module.exports = { enable, instrumentSource, getCollector }
