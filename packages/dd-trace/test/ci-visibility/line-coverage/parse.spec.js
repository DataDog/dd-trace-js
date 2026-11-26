'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

const LINE_COVERAGE = path.join(__dirname, '../../../src/ci-visibility/line-coverage')

// Instruments a module in a fresh process. Prints the result, and whether oxc-parser's package
// entry was loaded. The module has the literals the package gives values to and the binding does not.
// With FILLER_LINES, it first instruments a module of that many lines of 32 characters.
const SCRIPT = `
  const path = require('node:path')
  const { instrumentSource } = require(${JSON.stringify(LINE_COVERAGE)})
  const filler = Array.from({ length: Number(process.env.FILLER_LINES ?? 1) }, (_, i) =>
    \`exports.f\${String(i).padStart(12, '0')} = () => \${i % 10}\\n\`).join('')
  instrumentSource(filler, '/repository/filler.js')
  const code = 'function add (a, b) {\\n  return a + b\\n}\\nmodule.exports = { add, big: 1n, pattern: /a+/g }\\n'
  const instrumented = instrumentSource(code, '/repository/add.js')
  const isLoaded = part => Object.keys(require.cache).some(file => file.includes(path.join('oxc-parser', part)))
  const isEntryLoaded = isLoaded('src-js')
  const isRawTransferLoaded = isLoaded(path.join('src-js', 'raw-transfer'))
  let isRawTransferSupported = false
  try {
    isRawTransferSupported = require('oxc-parser').rawTransferSupported()
  } catch {}
  process.stdout.write(JSON.stringify({
    instrumented,
    isInstrumented: instrumented !== code,
    isEntryLoaded,
    isRawTransferLoaded,
    isRawTransferSupported,
  }))
`

/**
 * @param {Record<string, string>} [env]
 * @returns {{
 *   instrumented: string,
 *   isInstrumented: boolean,
 *   isEntryLoaded: boolean,
 *   isRawTransferLoaded: boolean,
 *   isRawTransferSupported: boolean
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

    // oxc-parser then loads the library this names, so line coverage leaves the choice to the package.
    const withEntry = instrumentInChild({ NAPI_RS_NATIVE_LIBRARY_PATH: getBindingLibrary() })
    assert.equal(withEntry.isEntryLoaded, true)
    assert.equal(withEntry.instrumented, withBinding.instrumented)
  })

  it('parses with raw transfer once a process has parsed 256 KiB, and instruments the same', function () {
    this.timeout(20_000)
    if (!['linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) this.skip()

    // 8,192 lines of 32 characters are 256 KiB, the last length parsed with JSON.
    const atLimit = instrumentInChild({ FILLER_LINES: '8192' })
    assert.equal(atLimit.isRawTransferLoaded, false)
    assert.equal(atLimit.isInstrumented, true)

    const pastLimit = instrumentInChild({ FILLER_LINES: '8193' })
    assert.equal(pastLimit.isRawTransferLoaded, pastLimit.isRawTransferSupported)
    assert.equal(pastLimit.instrumented, atLimit.instrumented)
  })
})
