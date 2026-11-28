'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const lineCoveragePath = require.resolve('../../src/ci-visibility/line-coverage')

// Node.js runs module hooks in the thread that loads modules from 22.15 and 23.5.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const moduleHooksIt = typeof Module.registerHooks === 'function' ? it : it.skip

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

  it('instruments files under dot-directories, except dependency and build-output directories', () => {
    const lineCoverage = loadFresh()
    lineCoverage.enable({ root, patchModuleLoader: false })

    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'docs/.vitepress/theme/index.js')), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'test/cases/.hidden-dir/deep.js')), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, '.eslintrc.js')), true)
    assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'app/.vite/deps/chunk.js')), false)
    for (const directory of [
      '.git', '.yarn', '.pnpm-store', '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.nx', '.cache',
      '.parcel-cache', '.angular', '.docusaurus', '.vercel',
    ]) {
      assert.strictEqual(lineCoverage.shouldInstrument(path.join(root, 'app', directory, 'chunk.js')), false, directory)
    }
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

    moduleHooksIt('keeps ECMAScript modules Node.js loads in node_modules/.cache, and loads them from there', () => {
      fs.mkdirSync(path.join(repository, 'node_modules'))
      const moduleFile = path.join(repository, 'answer.mjs')
      fs.writeFileSync(moduleFile, "export default 'compiled'\n")
      // A process of its own for each load: module hooks stay registered for the life of a process.
      const load = () => execFileSync(process.execPath, ['-e', `
        require(${JSON.stringify(lineCoveragePath)}).enable({ root: ${JSON.stringify(repository)} })
        import(${JSON.stringify(pathToFileURL(moduleFile).href)}).then(({ default: value }) => {
          process.stdout.write(value)
        })
      `], { encoding: 'utf8' })

      assert.strictEqual(load(), 'compiled')

      const cacheDirectory = path.join(repository, 'node_modules', '.cache', 'dd-trace-line-coverage')
      const entries = listFiles(cacheDirectory)
      assert.strictEqual(entries.length, 1)
      const text = fs.readFileSync(entries[0], 'utf8')
      const header = text.slice(0, text.indexOf(':'))
      const cached = "export default 'cached'\n"
      fs.writeFileSync(entries[0], `${header}:${cached.length}\n${cached}`)

      assert.strictEqual(load(), 'cached')
    })

    it('keeps no instrumented code when the repository has no node_modules', () => {
      loadFresh().enable({ root: repository })

      assert.strictEqual(require(file), 'compiled')
      assert.deepStrictEqual(fs.readdirSync(repository), ['answer.js'])
    })
  })
})
