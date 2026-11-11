'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { after, before, describe, it } = require('mocha')

const { createEsmWrapper } = require('../../src/helpers/bundler-esm-exports')

const FIXTURES = path.join(__dirname, 'bundler-esm-exports')
const RUNTIME_PATH = fs.realpathSync(require.resolve('import-in-the-middle/lib/register.js'))

const builtins = new Set(builtinModules)

/**
 * Lists the names a generated wrapper exports.
 *
 * @param {string} code
 */
function exportedNames (code) {
  const names = []
  for (const [, list] of code.matchAll(/^export \{ (.*) \}$/gm)) {
    for (const specifier of list.split(', ')) {
      const name = specifier.slice(specifier.indexOf(' as ') + 4)
      names.push(name === 'default' ? name : JSON.parse(name))
    }
  }
  return names.sort()
}

/**
 * Stands in for the bundler's resolver: Node.js resolution, with builtins kept as names and `externals` emitted by
 * their specifier.
 *
 * @param {{ externals?: string[], calls?: unknown[][] }} [options]
 */
function createResolve ({ externals = [], calls = [] } = {}) {
  /**
   * @param {string} specifier
   * @param {string} importer
   * @param {'import' | 'require'} kind
   */
  return async function resolve (specifier, importer, kind) {
    calls.push([specifier, importer, kind])
    if (specifier.startsWith('node:') || builtins.has(specifier)) return { path: specifier }
    const resolved = createRequire(importer).resolve(specifier)
    return externals.includes(specifier) ? { path: resolved, external: specifier } : { path: resolved }
  }
}

/**
 * @param {string} modulePath
 * @param {{ externals?: string[], calls?: unknown[][] }} [options]
 */
function wrap (modulePath, options) {
  return createEsmWrapper({ path: modulePath, specifier: 'fixture', resolve: createResolve(options) })
}

describe('createEsmWrapper', () => {
  let projectDir

  before(() => {
    projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-bundler-esm-exports-')))
    const packageDir = path.join(projectDir, 'node_modules', 'fake-package')
    fs.mkdirSync(packageDir, { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'fake-package', main: 'index.mjs' }))
    fs.writeFileSync(path.join(packageDir, 'index.mjs'), 'export const fromPackage = true\n')
  })

  after(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  /**
   * Writes the modules into a new directory and returns the path of the first one.
   *
   * @param {Record<string, string>} files
   */
  function writeModules (files) {
    const dir = fs.mkdtempSync(path.join(projectDir, 'case-'))
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source)
    }
    return path.join(dir, Object.keys(files)[0])
  }

  it('wraps a builtin by its node: URL and keeps it external', async () => {
    const wrapper = await createEsmWrapper({
      path: 'dns/promises',
      internal: true,
      specifier: 'dns/promises',
      resolve: createResolve(),
    })

    assert.ok(wrapper.code.includes('register("node:dns/promises", __binder, "dns/promises", "builtin")'))
    const names = [...Object.keys(require('node:dns/promises')), 'default'].sort()
    assert.deepStrictEqual(exportedNames(wrapper.code), names)
    assert.deepStrictEqual(wrapper.imports, new Map([
      ['./__iitm_runtime__.js', { path: RUNTIME_PATH, kind: 'runtime' }],
      ['./__iitm_module_0__.js', { path: 'node:dns/promises', external: true }],
    ]))
    assert.deepStrictEqual(wrapper.watchFiles, [])
  })

  it('registers an ES module by its file URL and maps the runtime and original placeholders', async () => {
    const modulePath = path.join(FIXTURES, 'export-default-method.mjs')

    const wrapper = await wrap(modulePath)

    assert.ok(wrapper.code.includes(
      `register(${JSON.stringify(pathToFileURL(modulePath).href)}, __binder, "fixture", "module")`
    ))
    assert.deepStrictEqual(exportedNames(wrapper.code), ['default'])
    assert.deepStrictEqual(wrapper.imports, new Map([
      ['./__iitm_runtime__.js', { path: RUNTIME_PATH, kind: 'runtime' }],
      ['./__iitm_module_0__.js', { path: modulePath, kind: 'original' }],
    ]))
    assert.deepStrictEqual(wrapper.watchFiles, [modulePath])
  })

  it('watches every module analyzed for star exports', async () => {
    const modulePath = path.join(FIXTURES, 'export-method-and-nested-method.mjs')

    const wrapper = await wrap(modulePath)

    assert.deepStrictEqual(exportedNames(wrapper.code), ['exportMethod', 'exportedMethod2'])
    assert.deepStrictEqual(wrapper.watchFiles, [modulePath, path.join(FIXTURES, 'export-method.mjs')])
  })

  it('resolves import and require re-exports through the bundler and analyzes them by their syntax', async () => {
    const calls = []
    const modulePath = writeModules({
      'index.mjs': "export * from './esm.js'\nexport * from './cjs.js'\n",
      'esm.js': 'export const fromEsm = true\n',
      'cjs.js': "module.exports = require('./required.js')\n",
      'required.js': 'exports.fromRequire = true\n',
    })
    const dir = path.dirname(modulePath)

    const wrapper = await wrap(modulePath, { calls })

    const names = exportedNames(wrapper.code).filter(name => name !== 'module.exports')
    assert.deepStrictEqual(names, ['fromEsm', 'fromRequire'])
    assert.deepStrictEqual(calls, [
      ['./esm.js', modulePath, 'import'],
      ['./cjs.js', modulePath, 'import'],
      ['./required.js', path.join(dir, 'cjs.js'), 'require'],
    ])
  })

  it('collects builtin and explicit module.exports star exports', async () => {
    const builtinPath = writeModules({ 'index.mjs': "export * from 'node:fs'\n" })

    const builtin = await wrap(builtinPath)
    const moduleExports = await wrap(path.join(FIXTURES, 'export-module-exports-star.mjs'))

    assert.ok(exportedNames(builtin.code).includes('readFile'))
    assert.deepStrictEqual(builtin.watchFiles, [builtinPath])
    assert.deepStrictEqual(exportedNames(moduleExports.code), ['module.exports'])
  })

  it('exports cyclic star exports and watches each module once', async () => {
    const modulePath = path.join(FIXTURES, 'export-cycle-a.mjs')

    const wrapper = await wrap(modulePath)

    assert.deepStrictEqual(exportedNames(wrapper.code), ['fromA', 'fromB'])
    assert.deepStrictEqual(wrapper.watchFiles, [modulePath, path.join(FIXTURES, 'export-cycle-b.mjs')])
  })

  it('exports TypeScript modules and star exports without transpiling them', async () => {
    const root = await wrap(path.join(FIXTURES, 'typescript-export.mts'))
    const star = await wrap(path.join(FIXTURES, 'export-typescript-star.mjs'))

    assert.deepStrictEqual(exportedNames(root.code), ['Client'])
    assert.deepStrictEqual(exportedNames(star.code), ['Client', 'sibling', 'value'])
  })

  it('imports a name reached through two star exports from its defining module', async () => {
    const modulePath = writeModules({
      'index.mjs': "export * from './left.mjs'\nexport * from './right.mjs'\n",
      'left.mjs': "export * from './shared.mjs'\n",
      'right.mjs': "export * from './shared.mjs'\n",
      'shared.mjs': 'export const shared = true\n',
    })

    const wrapper = await wrap(modulePath)

    assert.deepStrictEqual(exportedNames(wrapper.code), ['shared'])
    assert.ok(wrapper.code.includes('import * as __ns0 from "./__iitm_module_1__.js"'))
    assert.deepStrictEqual(wrapper.imports.get('./__iitm_module_1__.js'), {
      path: path.join(path.dirname(modulePath), 'shared.mjs'),
      kind: 'module',
    })
  })

  it('analyzes re-exports the bundle keeps external and keeps their imports external', async () => {
    const modulePath = writeModules({
      'index.mjs': "export * from './left.mjs'\nexport * from './right.mjs'\n",
      'left.mjs': "export * from 'fake-package'\n",
      'right.mjs': "export * from 'fake-package'\n",
    })

    const wrapper = await wrap(modulePath, { externals: ['fake-package'] })

    assert.deepStrictEqual(exportedNames(wrapper.code), ['fromPackage'])
    assert.deepStrictEqual(wrapper.imports.get('./__iitm_module_1__.js'), { path: 'fake-package', external: true })
  })

  it('rejects with the error of a failed resolution', async () => {
    const error = new Error('cannot resolve')
    const modulePath = writeModules({ 'index.mjs': "export * from './missing.mjs'\n" })

    await assert.rejects(createEsmWrapper({
      path: modulePath,
      specifier: 'fixture',
      resolve: () => Promise.reject(error),
    }), error)
  })
})
