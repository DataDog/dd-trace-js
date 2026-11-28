'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

const LINE_COVERAGE = path.join(__dirname, '../../../src/ci-visibility/line-coverage')

// Instruments a module in a fresh process. Prints the result, whether oxc-parser's package entry was
// loaded, and the parser named before and after. The module has the literals the package gives values
// to and the binding does not.
const SCRIPT = `
  const path = require('node:path')
  const { getParserInUse, instrumentSource } = require(${JSON.stringify(LINE_COVERAGE)})
  const code = 'function add (a, b) {\\n  return a + b\\n}\\nmodule.exports = { add, big: 1n, pattern: /a+/g }\\n'
  const parserBefore = getParserInUse()
  const instrumented = instrumentSource(code, '/repository/add.js')
  const entry = path.join('oxc-parser', 'src-js')
  const isEntryLoaded = Object.keys(require.cache).some(file => file.includes(entry))
  process.stdout.write(JSON.stringify({
    instrumented,
    isInstrumented: instrumented !== code,
    isEntryLoaded,
    parserBefore,
    parser: getParserInUse(),
  }))
`

/**
 * @param {Record<string, string>} [env]
 * @returns {{
 *   instrumented: string,
 *   isInstrumented: boolean,
 *   isEntryLoaded: boolean,
 *   parserBefore: string,
 *   parser: string
 * }}
 */
function instrumentInChild (env) {
  const output = execFileSync(process.execPath, ['-e', SCRIPT], { env: { ...process.env, ...env } })
  return JSON.parse(output.toString())
}

// The native library of oxc-parser's binding package for this platform.
function getBindingLibrary () {
  const oxcDirectory = path.dirname(require.resolve('oxc-parser/package.json'))
  let target = `${process.platform}-${process.arch}`
  if (process.platform === 'linux') target += readFileSync('/usr/bin/ldd', 'utf8').includes('musl') ? '-musl' : '-gnu'
  return require.resolve(`@oxc-parser/binding-${target}`, { paths: [oxcDirectory] })
}

describe('line coverage parsing', () => {
  it('parses with the native binding alone, as oxc-parser\'s package entry would', function () {
    if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) this.skip()

    const withBinding = instrumentInChild()
    assert.equal(withBinding.isInstrumented, true)
    assert.equal(withBinding.isEntryLoaded, false)
    assert.equal(withBinding.parserBefore, 'none')
    assert.equal(withBinding.parser, 'oxc-binding')

    // oxc-parser then loads the library this names, so line coverage leaves the choice to the package.
    const withEntry = instrumentInChild({ NAPI_RS_NATIVE_LIBRARY_PATH: getBindingLibrary() })
    assert.equal(withEntry.isEntryLoaded, true)
    assert.equal(withEntry.instrumented, withBinding.instrumented)
    assert.equal(withEntry.parser, 'oxc-parser')
  })

  it('names meriyah as the parser when neither the binding nor the package loads', () => {
    const withNeither = instrumentInChild({ NAPI_RS_NATIVE_LIBRARY_PATH: path.join(__dirname, 'missing-binding.node') })

    assert.equal(withNeither.isInstrumented, true)
    assert.equal(withNeither.parserBefore, 'none')
    assert.equal(withNeither.parser, 'meriyah')
  })
})
