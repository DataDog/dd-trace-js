'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, before, afterEach, beforeEach, describe, it } = require('mocha')
const { SourceMapGenerator } = require('../../../../vendor/dist/source-map')
require('../setup/mocha')

const sourceMaps = require('../../src/source-maps')

// `setSourceMapsSupport` (and therefore flagless remapping) only exists on Node >=22.14/23.7. The
// remapping assertions depend on Node actually parsing the maps, so they are skipped on older
// runtimes where `isSupported()` is false. The install contract is asserted regardless.
const canResolve = sourceMaps.isSupported()

let tmpDir

/**
 * Write a CommonJS module whose three functions live on original lines 1-3 of a `.ts` source, with
 * a source map attached either inline (as a data URI) or as an external `.map` file.
 *
 * @param {string} name Base name without extension; doubles as a unique require path per test.
 * @param {'inline' | 'external'} mapKind Where to attach the source map.
 * @returns {string} Absolute path to the generated `.js` file.
 */
function writeTranspiledModule (name, mapKind) {
  const generator = new SourceMapGenerator({ file: `${name}.js` })
  const lines = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    `function ${name}Inner () { throw new Error("boom"); }`,
    `function ${name}Outer () { return ${name}Inner(); }`,
    `exports.run = function run () { return ${name}Outer(); };`,
  ]
  generator.addMapping({ generated: { line: 3, column: 0 }, original: { line: 1, column: 0 }, source: `${name}.ts` })
  generator.addMapping({ generated: { line: 4, column: 0 }, original: { line: 2, column: 0 }, source: `${name}.ts` })
  generator.addMapping({ generated: { line: 5, column: 0 }, original: { line: 3, column: 0 }, source: `${name}.ts` })

  const jsPath = path.join(tmpDir, `${name}.js`)
  if (mapKind === 'inline') {
    const inline = Buffer.from(generator.toString()).toString('base64')
    lines.push(`//# sourceMappingURL=data:application/json;base64,${inline}`)
  } else {
    fs.writeFileSync(path.join(tmpDir, `${name}.js.map`), generator.toString())
    lines.push(`//# sourceMappingURL=${name}.js.map`)
  }
  fs.writeFileSync(jsPath, lines.join('\n'))
  return jsPath
}

describe('source-maps', function () {
  let originalPrepareStackTrace

  before(function () {
    tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dd-source-maps-'))
  })

  after(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(function () {
    originalPrepareStackTrace = Error.prepareStackTrace
  })

  afterEach(function () {
    sourceMaps.disable()
    // Tests that install a user handler must not leak it into the next test's `enable()`.
    Error.prepareStackTrace = originalPrepareStackTrace
  })

  describe('enable / disable', function () {
    it('installs and uninstalls the stack-trace handler', function () {
      const previous = Error.prepareStackTrace
      sourceMaps.enable()
      if (!canResolve) {
        assert.strictEqual(sourceMaps._isInstalled(), false)
        return
      }
      assert.strictEqual(sourceMaps._isInstalled(), true)
      assert.notStrictEqual(Error.prepareStackTrace, previous)

      sourceMaps.disable()
      assert.strictEqual(sourceMaps._isInstalled(), false)
      assert.strictEqual(Error.prepareStackTrace, previous)
    })

    it('is idempotent', function () {
      sourceMaps.enable()
      const handler = Error.prepareStackTrace
      sourceMaps.enable()
      assert.strictEqual(Error.prepareStackTrace, handler)
    })

    it('does not throw when disabling without enabling', function () {
      sourceMaps.disable()
      assert.strictEqual(sourceMaps._isInstalled(), false)
    })
  })

  describe('remapping', function () {
    if (!canResolve) return

    for (const mapKind of ['inline', 'external']) {
      it(`remaps ${mapKind}-mapped frames to the original source`, function () {
        const modulePath = writeTranspiledModule(`${mapKind}app`, mapKind)
        sourceMaps.enable()
        const { run } = require(modulePath)

        assert.throws(run, (error) => {
          const frames = error.stack.split('\n').slice(1, 4)
          assert.match(frames[0], new RegExp(`${mapKind}app\\.ts:1:1`))
          assert.match(frames[1], new RegExp(`${mapKind}app\\.ts:2:1`))
          assert.match(frames[2], new RegExp(`${mapKind}app\\.ts:3:1`))
          return true
        })
      })
    }

    it('delegates to a user-provided prepareStackTrace with original locations', function () {
      const modulePath = writeTranspiledModule('userhandler', 'inline')
      Error.prepareStackTrace = (_error, callSites) => callSites
      sourceMaps.enable()
      const { run } = require(modulePath)

      assert.throws(run, (error) => {
        const top = error.stack[0]
        assert.match(top.getFileName(), /userhandler\.ts$/)
        assert.strictEqual(top.getLineNumber(), 1)
        assert.strictEqual(top.getColumnNumber(), 1)
        return true
      })
    })

    it('preserves a user handler that returns a custom string', function () {
      const modulePath = writeTranspiledModule('customstring', 'inline')
      Error.prepareStackTrace = (_error, callSites) =>
        callSites.map((callSite) => `${callSite.getFileName()}:${callSite.getLineNumber()}`).join('|')
      sourceMaps.enable()
      const { run } = require(modulePath)

      assert.throws(run, (error) => {
        assert.match(error.stack.split('|')[0], /customstring\.ts:1$/)
        return true
      })
    })

    it('leaves frames without a source map untouched', function () {
      const modulePath = path.join(tmpDir, 'nomap.js')
      fs.writeFileSync(modulePath, 'exports.run = function run () { throw new Error("plain"); }\n')
      sourceMaps.enable()
      const { run } = require(modulePath)

      assert.throws(run, (error) => {
        assert.match(error.stack.split('\n')[1], /nomap\.js/)
        return true
      })
    })
  })
})
