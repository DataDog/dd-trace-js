'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const sinon = require('sinon')

const { processModule } = require('../src/utils.js')
const transformTypeScript = require('./helpers/transform-typescript')

describe('esbuild utils', () => {
  describe('processModule', () => {
    it('should set a single exported method', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-method.mjs'),
        context: { format: 'module' },
      })
      assert.strictEqual(setters.size, 1)
      assert.strictEqual(setters.has('exportMethod'), true)
    })

    it('should set the default exported method', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-default-method.mjs'),
        context: { format: 'module' },
      })

      assert.strictEqual(setters.size, 1)
      assert.strictEqual(setters.has('default'), true)
    })

    it('should set the nested exports', async () => {
      const modulePath = path.join(__dirname, 'resources', 'export-method-and-nested-method.mjs')
      const nestedPath = path.join(__dirname, 'resources', 'export-method.mjs')
      const moduleSources = new Map()
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources,
      })

      assert.strictEqual(setters.size, 2)
      assert.strictEqual(setters.has('exportMethod'), true)
      assert.strictEqual(setters.has('exportedMethod2'), true)
      assert.strictEqual(moduleSources.size, 2)
      assert.strictEqual(moduleSources.get(modulePath), fs.readFileSync(modulePath, 'utf8'))
      assert.strictEqual(moduleSources.get(nestedPath), fs.readFileSync(nestedPath, 'utf8'))
    })

    it('should resolve bare star exports with import conditions', async () => {
      const modulePath = path.join(__dirname, 'resources', 'export-bare-star.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[modulePath, "export * from '@actions/core'\n"]]),
      })

      assert.strictEqual(setters.has('setSecret'), true)
    })

    it('should resolve package imports with import conditions', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'imports', 'index.mjs'),
        context: { format: 'module' },
      })

      assert.strictEqual(setters.has('imported'), true)
    })

    it('should collect builtin star exports without reading them as files', async () => {
      const modulePath = path.join(__dirname, 'resources', 'export-builtin.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[modulePath, "export * from 'node:fs'\n"]]),
      })

      assert.strictEqual(setters.has('readFile'), true)
    })

    it('should reject non-file star export targets', async () => {
      const nonFilePath = path.join(__dirname, 'resources', 'export-non-file.mjs')

      await assert.rejects(processModule({
        path: nonFilePath,
        context: { format: 'module' },
        moduleSources: new Map([[
          nonFilePath,
          "export * from 'data:text/javascript,export const value = true'\n",
        ]]),
      }), /Unsupported ESM resolution URL: data:/)
    })

    it('should reject native module star exports', async () => {
      const nativePath = path.join(__dirname, 'resources', 'export-native.mjs')

      await assert.rejects(processModule({
        path: nativePath,
        context: { format: 'module' },
        moduleSources: new Map([[nativePath, "export * from './value.node'\n"]]),
      }), /Unsupported ESM analysis target: .*value\.node/)
    })

    it('should ignore JSON star exports', async () => {
      const jsonPath = path.join(__dirname, 'resources', 'export-json.mjs')
      const setters = await processModule({
        path: jsonPath,
        context: { format: 'module' },
        moduleSources: new Map([[jsonPath, "export * from './value.json'\n"]]),
      })

      assert.deepStrictEqual([...setters.keys()], [])
    })

    it('should terminate cyclic star exports', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-cycle-a.mjs'),
        context: { format: 'module' },
      })

      assert.deepStrictEqual([...setters.keys()].sort(), ['fromA', 'fromB'])
    })

    it('should preserve same-origin star exports and exclude ambiguous origins', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-star-identity-root.mjs'),
        context: { format: 'module' },
      })

      assert.deepStrictEqual([...setters.keys()], ['diamond'])
    })

    it('should set TypeScript star exports', async () => {
      let transforms = 0
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-typescript-star.mjs'),
        context: { format: 'module' },
        transform: (source, options) => {
          transforms++
          return transformTypeScript(source, options)
        },
      })

      assert.deepStrictEqual([...setters.keys()].sort(), ['Client', 'sibling', 'value'])
      assert.strictEqual(transforms, 3)
    })

    it('should preserve explicit ESM module.exports star exports', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-module-exports-star.mjs'),
        context: { format: 'module' },
      })

      assert.deepStrictEqual([...setters.keys()], ['module.exports'])
    })

    it('should exclude every CommonJS default export spelling', async () => {
      const commonJsPath = path.join(__dirname, 'resources', 'export-commonjs.cjs')
      const typeScriptPath = path.join(__dirname, 'resources', 'export-commonjs.cts')
      const [commonJsSetters, typeScriptSetters] = await Promise.all([
        processModule({
          path: commonJsPath,
          context: { format: 'commonjs' },
          excludeDefault: true,
          moduleSources: new Map([[commonJsPath, 'module.exports = { value: true }']]),
        }),
        processModule({
          path: typeScriptPath,
          context: { format: 'commonjs' },
          excludeDefault: true,
          moduleSources: new Map([[typeScriptPath, 'const value: number = 1\nmodule.exports = { value }']]),
          transform: transformTypeScript,
        }),
      ])

      assert.deepStrictEqual([...commonJsSetters.keys()], ['value'])
      assert.deepStrictEqual([...typeScriptSetters.keys()], ['value'])
    })

    it('should set the native module exports', async () => {
      const setters = await processModule({
        path: 'http',
        internal: true,
        context: { format: 'module' },
      })

      assert.strictEqual(setters.size, Object.keys(await import('http')).length)
      assert.strictEqual(setters.has('default'), true)
      assert.strictEqual(setters.has('createServer'), true)
      assert.strictEqual(setters.has('METHODS'), true)
    })

    it('should generate distinct locals for export names that sanitize identically', async () => {
      const modulePath = path.join(__dirname, 'resources', 'colliding-export-names.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[
          modulePath,
          'const foo_bar = 1, fooBar = 2\nexport { foo_bar, fooBar as "foo-bar" }\n',
        ]]),
      })
      const source = `
        const namespace = { foo_bar: 1, 'foo-bar': 2 }
        const _ = {}
        const set = {}
        const get = {}
        ${[...setters.values()].join('\n')}
      `
      const namespace = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

      assert.strictEqual(namespace.foo_bar, 1)
      assert.strictEqual(namespace['foo-bar'], 2)
    })
  })

  describe('isESM', () => {
    let isESMFile, readFileSync

    beforeEach(() => {
      isESMFile = require('../src/utils').isESMFile
      readFileSync = sinon.stub(fs, 'readFileSync')
      readFileSync.callsFake(function () {
        throw new Error('File does not exist')
      })
    })

    afterEach(() => {
      readFileSync.restore()
    })

    it('should return true if the file has a .mjs extension', () => {
      assert.strictEqual(isESMFile('/path/to/test.mjs'), true)
    })

    it('should return false if the file has a .cjs extension', () => {
      assert.strictEqual(isESMFile('/path/to/test.cjs'), false)
    })

    it('should return true if the file has a .mts extension in a CommonJS package', () => {
      assert.strictEqual(isESMFile('/path/to/test.mts', '/path/to/package.json', { type: 'commonjs' }), true)
    })

    it('should return false if the file has a .cts extension in an ESM package', () => {
      assert.strictEqual(isESMFile('/path/to/test.cts', '/path/to/package.json', { type: 'module' }), false)
    })

    it('should return true if the file is in a directory with a package.json that has a type of module', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', { type: 'module' }), true)
    })

    it('should return false if the file is in a directory with a package.json that has a type of commonjs', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', { type: 'commonjs' }), false)
    })

    it('should return false if the file is in a directory with a package.json without a type', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', {}), false)
    })

    it('should return true if the file has a package.json before the main with type module', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({ type: 'module' })
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'commonjs' }), true)
    })

    it('should return false if the file has a package.json before the main with type commonjs', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({ type: 'commonjs' })
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'module' }), false)
    })

    it('should return false if the file has a package.json before the main without any type defined', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({})
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'module' }), false)
    })
  })
})
