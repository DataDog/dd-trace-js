'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const lineCoveragePath = require.resolve('../../src/ci-visibility/line-coverage')

describe('line coverage enable', () => {
  const originalCompile = Module.prototype._compile
  const root = path.resolve(__dirname, '../../../..')

  function loadFresh () {
    delete require.cache[lineCoveragePath]
    return require(lineCoveragePath)
  }

  afterEach(() => {
    Module.prototype._compile = originalCompile
    delete require.cache[lineCoveragePath]
  })

  it('compiles modules of the root through the instrumenter by default', () => {
    const lineCoverage = loadFresh()
    lineCoverage.enable({ root })

    assert.notStrictEqual(Module.prototype._compile, originalCompile)
    assert.strictEqual(lineCoverage.isActive(), true)
  })

  it('leaves Node.js module loader alone when asked to', () => {
    const lineCoverage = loadFresh()
    lineCoverage.enable({ root, patchModuleLoader: false })

    assert.strictEqual(Module.prototype._compile, originalCompile)
    assert.strictEqual(lineCoverage.isActive(), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'packages/dd-trace/src/id.js')), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'node_modules/x/index.js')), false)
  })

  it('does not instrument anything before it is enabled', () => {
    const lineCoverage = loadFresh()

    assert.strictEqual(lineCoverage.isActive(), false)
  })

  describe('cache of instrumented code', () => {
    let repository
    let file

    beforeEach(() => {
      repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-line-coverage-cache-')))
      file = path.join(repository, 'answer.js')
      fs.writeFileSync(file, "module.exports = 'compiled'\n")
    })

    afterEach(() => {
      delete require.cache[file]
      fs.rmSync(repository, { recursive: true, force: true })
    })

    /**
     * @param {string} directory
     * @returns {string[]} the files under `directory`
     */
    function listFiles (directory) {
      return fs.readdirSync(directory).flatMap(name => {
        const entry = path.join(directory, name)
        return fs.statSync(entry).isDirectory() ? listFiles(entry) : [entry]
      })
    }

    it('keeps what Node.js loader instruments in node_modules/.cache, and loads it from there', () => {
      fs.mkdirSync(path.join(repository, 'node_modules'))
      loadFresh().enable({ root: repository })
      assert.strictEqual(require(file), 'compiled')

      const cacheDirectory = path.join(repository, 'node_modules', '.cache', 'dd-trace-line-coverage')
      const entries = listFiles(cacheDirectory)
      assert.strictEqual(entries.length, 1)
      // What another process would find there, written as the cache writes it.
      const text = fs.readFileSync(entries[0], 'utf8')
      const header = text.slice(0, text.indexOf(':'))
      const cached = "module.exports = 'cached'\n"
      fs.writeFileSync(entries[0], `${header}:${cached.length}\n${cached}`)

      delete require.cache[file]
      Module.prototype._compile = originalCompile
      loadFresh().enable({ root: repository })

      assert.strictEqual(require(file), 'cached')
    })

    it('keeps no instrumented code when the repository has no node_modules', () => {
      loadFresh().enable({ root: repository })

      assert.strictEqual(require(file), 'compiled')
      assert.deepStrictEqual(fs.readdirSync(repository), ['answer.js'])
    })
  })
})
