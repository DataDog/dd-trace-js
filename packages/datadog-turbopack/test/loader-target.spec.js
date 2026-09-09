'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const loader = require('../src/loader')
const {
  applyDatadogTurbopack,
  cleanup,
  createLinkedAiProject,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('./helpers')

describe('datadog-turbopack target loader', () => {
  afterEach(() => {
    cleanup()
    sinon.restore()
  })

  it('leaves application and unmatched package modules unchanged', async () => {
    const projectDir = createProject()
    const appPath = write(projectDir, 'app/route.js', "import 'ai'\n")
    const packageDir = createPackage(projectDir, 'unmatched', { main: 'index.js', version: '1.0.0' })
    const packagePath = write(packageDir, 'index.js', 'module.exports = true\n')
    const options = await createLoaderOptions(projectDir)
    const getResolve = sinon.stub().throws(new Error('must not resolve'))

    const [app, unmatched] = await Promise.all([
      runLoader(appPath, fs.readFileSync(appPath, 'utf8'), options, { getResolve }),
      runLoader(packagePath, fs.readFileSync(packagePath, 'utf8'), options, { getResolve }),
    ])

    assert.equal(app, "import 'ai'\n")
    assert.equal(unmatched, 'module.exports = true\n')
    sinon.assert.notCalled(getResolve)
  })

  it('wraps resolved ESM and CommonJS package entries', async () => {
    const fixture = await createPackageFixture()
    const getResolve = createResolver(fixture.projectDir)
    const [esm, commonjs] = await Promise.all([
      runLoader(fixture.aiPath, fixture.aiSource, fixture.options, { getResolve }),
      runLoader(fixture.ioredisPath, fixture.ioredisSource, fixture.options, { getResolve }),
    ])

    assert.match(esm, /registerWithData/)
    assert.match(esm, /index\.mjs\?__dd_iitm_original=ai/)
    assert.match(commonjs, /registerCommonJS/)
    assert.match(commonjs, /"moduleName":"ioredis"/)
  })

  it('wraps linked workspace package entries', async () => {
    const source = createAiSource()
    const { config, files, projectDir } = await createLinkedAiProject({
      exports: { import: './dist/index.mjs', require: './dist/index.cjs' },
      main: './dist/index.cjs',
      type: 'module',
      version: '7.0.0',
    }, {
      'dist/index.cjs': 'module.exports = {}\n',
      'dist/index.mjs': source,
    })
    const options = findDatadogLoaders(config)[0].options
    const workspaceDir = path.resolve(projectDir, '../..')

    const result = await runLoader(files['dist/index.mjs'], source, options, {
      getResolve: createResolver(workspaceDir),
    })

    assert.match(result, /registerWithData/)
    assert.match(result, /index\.mjs\?__dd_iitm_original=ai%2Fdist%2Findex\.mjs/)
    assert.match(result, /__binder, "ai", \{"moduleName":"ai\/dist\/index\.mjs"/)
  })

  it('returns rewritten ESM source only for the matching original-source query', async () => {
    const fixture = await createPackageFixture()
    const settings = { getResolve: createResolver(fixture.projectDir) }
    const original = await runLoader(fixture.aiPath, fixture.aiSource, fixture.options, {
      ...settings,
      resourceQuery: '?__dd_iitm_original=ai',
    })
    const unrelated = await runLoader(fixture.aiPath, fixture.aiSource, fixture.options, {
      ...settings,
      resourceQuery: '?other=1&__dd_iitm_original=other',
    })

    assert.doesNotMatch(original, /registerWithData/)
    assert.equal(original, fixture.aiSource)
    assert.match(unrelated, /registerWithData/)
  })

  it('detects typeless ESM and CommonJS entries from their source', async () => {
    const fixture = await createPackageFixture({ typeless: true })
    const getResolve = createResolver(fixture.projectDir)
    const [esm, commonjs] = await Promise.all([
      runLoader(fixture.aiPath, fixture.aiSource, fixture.options, { getResolve }),
      runLoader(fixture.ioredisPath, fixture.ioredisSource, fixture.options, { getResolve }),
    ])

    assert.match(esm, /registerWithData/)
    assert.match(esm, /index\.js\?__dd_iitm_original=ai/)
    assert.match(commonjs, /registerCommonJS/)
  })

  it('parses a typeless TypeScript entry with the Next.js compiler', async () => {
    const fixture = await createPackageFixture({ typescript: true })

    const result = await runLoader(fixture.aiPath, fixture.aiSource, fixture.options, {
      getResolve: createResolver(fixture.projectDir),
    })

    assert.match(result, /registerWithData/)
    assert.match(result, /index\.ts\?__dd_iitm_original=ai/)
  })

  it('resolves ESM star exports through IITM', async () => {
    const fixture = await createPackageFixture()
    const nestedPath = write(path.dirname(fixture.aiPath), 'nested.mjs', [
      "export let mutable = 'initial'",
      "mutable = 'updated'",
      'export const fixed = true',
      '',
    ].join('\n'))
    const unknownPath = write(path.dirname(fixture.aiPath), 'unknown.extension', 'export const unknown = true\n')
    const packageDir = createPackage(fixture.projectDir, 'nested', {
      exports: { import: './index.mjs', require: './index.cjs' },
      main: 'index.cjs',
      type: 'module',
      version: '1.0.0',
    })
    write(packageDir, 'index.mjs', 'export const packageValue = true\n')
    write(packageDir, 'index.cjs', 'module.exports = {}\n')
    const source = [
      "export * from './nested.mjs'",
      "export * from './unknown.extension'",
      "export * from 'nested'",
      "export * from 'node:fs'",
      '',
    ].join('\n')

    const result = await runLoader(fixture.aiPath, source, fixture.options, {
      getResolve: createResolver(fixture.projectDir),
    })

    assert.match(result, /registerWithData/)
    assert.match(result, /export \{ mutable \} from "\.\/index\.mjs\?__dd_iitm_original=ai"/)
    assert.doesNotMatch(result, /export \{ fixed \} from "\.\/index\.mjs\?__dd_iitm_original=ai"/)
    assert.equal(fs.existsSync(nestedPath), true)
    assert.equal(fs.existsSync(unknownPath), true)
  })

  it('fails open when an ESM re-export does not resolve to a file', async () => {
    const fixture = await createPackageFixture()
    const source = "export * from 'nested'\n"
    const getResolve = createResolver(fixture.projectDir, { nested: 'virtual:nested' })
    const emitWarning = sinon.spy()

    const result = await runLoader(fixture.aiPath, source, fixture.options, { emitWarning, getResolve })

    assert.equal(result, source)
    sinon.assert.calledOnceWithExactly(
      emitWarning,
      sinon.match.has('message', 'Could not resolve nested to a file')
    )
  })

  it('matches declared package files without resolving a package entry', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ai', { type: 'module', version: '6.0.0' })
    const resourcePath = write(packageDir, 'dist/index.mjs', createAiSource())
    const options = await createLoaderOptions(projectDir)
    const getResolve = sinon.spy(createResolver(projectDir))

    const result = await runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options, { getResolve })

    assert.match(result, /registerWithData/)
    sinon.assert.calledOnce(getResolve)
  })

  it('leaves an unresolved package entry unchanged', async () => {
    const fixture = await createPackageFixture()
    const getResolve = () => (directory, request, callback) => callback(new Error(`Cannot resolve ${request}`))

    const result = await runLoader(fixture.aiPath, fixture.aiSource, fixture.options, { getResolve })

    assert.equal(result, fixture.aiSource)
  })

  it('leaves invalid successful package-entry resolutions unchanged', async () => {
    const fixture = await createPackageFixture()
    for (const resolved of [undefined, 'virtual:ai']) {
      const getResolve = () => (directory, request, callback) => callback(undefined, resolved)
      const result = await runLoader(fixture.aiPath, fixture.aiSource, fixture.options, { getResolve })
      assert.equal(result, fixture.aiSource)
    }
  })

  it('preserves an input source map for CommonJS wrappers', async () => {
    const fixture = await createPackageFixture()
    const sourceMap = { mappings: 'AAAA', sources: [fixture.ioredisPath], version: 3 }
    const { code, map } = await runLoaderResult(
      fixture.ioredisPath,
      fixture.ioredisSource,
      fixture.options,
      { getResolve: createResolver(fixture.projectDir), sourceMap }
    )

    assert.match(code, /registerCommonJS/)
    assert.equal(map, sourceMap)
    assert.equal(map.mappings, ';AAAA')
  })

  it('recovers synthetic extensionless resources', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'runner', version: '5.0.0' })
    const source = 'module.exports = { value: true }\n'
    const resourcePath = write(packageDir, 'runner', source)
    const options = await createLoaderOptions(projectDir)

    const result = await runLoader(`${resourcePath}.__dd_trace_turbopack.js`, source, options, {
      getResolve: createResolver(projectDir),
    })

    assert.match(result, /registerCommonJS/)
  })

  it('fails open for invalid options and package metadata', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    const source = 'module.exports = true\n'
    const resourcePath = write(packageDir, 'index.js', source)
    const emitWarning = sinon.spy()

    for (const options of [undefined, {}, { compiler: {} }]) {
      const result = await runLoader(resourcePath, source, options, { emitWarning })
      assert.equal(result, source)
    }
    const throwingOptions = new Proxy({}, {
      get () {
        // eslint-disable-next-line no-throw-literal -- Verify normalization of a dependency's non-Error failure.
        throw 'invalid options'
      },
    })
    const invalidResult = await runLoader(resourcePath, source, throwingOptions, { emitWarning })

    assert.equal(invalidResult, source)
    assert.ok(emitWarning.lastCall.args[0] instanceof Error)
    assert.equal(emitWarning.lastCall.args[0].message, 'invalid options')

    fs.writeFileSync(path.join(packageDir, 'package.json'), '{')
    const result = await runLoader(resourcePath, source, await createLoaderOptions(projectDir), { emitWarning })

    assert.equal(result, source)
    assert.equal(emitWarning.callCount, 5)
    assert.match(emitWarning.lastCall.args[0].message, /JSON/)
  })
})

/**
 * @param {{ typeless?: boolean, typescript?: boolean }} [settings]
 * @returns {Promise<{
 *   aiPath: string,
 *   aiSource: string,
 *   ioredisPath: string,
 *   ioredisSource: string,
 *   options: object,
 *   projectDir: string
 * }>}
 */
async function createPackageFixture (settings = {}) {
  const projectDir = createProject()
  const aiEntry = settings.typescript ? 'index.ts' : settings.typeless ? 'index.js' : 'index.mjs'
  const aiManifest = {
    exports: { import: `./${aiEntry}`, require: './index.cjs' },
    main: 'index.cjs',
    version: '7.0.0',
  }
  if (!settings.typeless && !settings.typescript) aiManifest.type = 'module'
  const aiDirectory = createPackage(projectDir, 'ai', aiManifest)
  const aiSource = createAiSource()
  const aiPath = write(aiDirectory, aiEntry, aiSource)
  write(aiDirectory, 'index.cjs', 'module.exports = {}\n')

  const ioredisDirectory = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
  const ioredisSource = settings.typeless
    ? 'return\nmodule.exports = { value: true }\n'
    : 'module.exports = { value: true }\n'
  const ioredisPath = write(ioredisDirectory, 'index.js', ioredisSource)
  const options = await createLoaderOptions(projectDir)
  return { aiPath, aiSource, ioredisPath, ioredisSource, options, projectDir }
}

/**
 * @param {string} projectDir
 * @returns {Promise<object>}
 */
async function createLoaderOptions (projectDir) {
  const config = await applyDatadogTurbopack({}, { projectDir })
  return findDatadogLoaders(config)[0].options
}

/**
 * @param {string} projectDir
 * @param {Record<string, unknown>} [overrides]
 * @returns {(resolveOptions: { conditionNames: string[] }) => Function}
 */
function createResolver (projectDir, overrides = {}) {
  return resolveOptions => (directory, request, callback) => {
    try {
      if (Object.hasOwn(overrides, request)) return callback(undefined, overrides[request])
      const packageDirectory = path.join(projectDir, 'node_modules', request)
      const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
      const condition = resolveOptions.conditionNames.includes('import') ? 'import' : 'require'
      const entry = manifest.exports !== null && typeof manifest.exports === 'object'
        ? manifest.exports[condition]
        : manifest.main
      callback(undefined, path.join(packageDirectory, entry))
    } catch (error) {
      callback(error)
    }
  }
}

/**
 * @returns {string}
 */
function createAiSource () {
  return [
    "export function generateText () { return 'original' }",
    'export function getTracer () {}',
    'export function resolveLanguageModel (value) { return value }',
    'export function selectTelemetryAttributes (value) { return value }',
    "export let state = 'initial'",
    'export function setState (value) { state = value }',
    '',
  ].join('\n')
}

/**
 * @param {string} resourcePath
 * @param {string} source
 * @param {unknown} options
 * @param {{ emitWarning?: Function, getResolve?: Function, resourceQuery?: string, sourceMap?: object }} [settings]
 * @returns {Promise<string>}
 */
async function runLoader (resourcePath, source, options, settings = {}) {
  const { code } = await runLoaderResult(resourcePath, source, options, settings)
  return code
}

/**
 * @param {string} resourcePath
 * @param {string} source
 * @param {unknown} options
 * @param {{ emitWarning?: Function, getResolve?: Function, resourceQuery?: string, sourceMap?: object }} [settings]
 * @returns {Promise<{ code: string, map?: object }>}
 */
function runLoaderResult (resourcePath, source, options, settings = {}) {
  return new Promise((resolve, reject) => {
    /**
     * @param {Error} [error]
     * @param {string} [code]
     * @param {object} [map]
     */
    function callback (error, code, map) {
      if (error) {
        reject(error)
      } else {
        resolve({ code: /** @type {string} */ (code), map })
      }
    }

    loader.call({
      addDependency () {},
      async: () => callback,
      emitWarning: settings.emitWarning,
      getOptions: () => options,
      getResolve: settings.getResolve ?? (() => () => {}),
      resourceQuery: settings.resourceQuery,
      resourcePath,
    }, source, settings.sourceMap)
  })
}
