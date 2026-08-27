'use strict'

const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const sinon = require('sinon')
const { processModule } = require('../src/utils.js')

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
      const setters = await processModule({
        path: path.join(__dirname, 'resources', 'export-method-and-nested-method.mjs'),
        context: { format: 'module' },
      })

      assert.strictEqual(setters.size, 2)
      assert.strictEqual(setters.has('exportMethod'), true)
      assert.strictEqual(setters.has('exportedMethod2'), true)
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

    it('can discover ESM exports without evaluating the module', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-'))
      const marker = path.join(directory, 'evaluated')
      const source = path.join(directory, 'module.mjs')
      fs.writeFileSync(source, [
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'yes')`,
        'export const value = 1',
      ].join('; '))

      try {
        const setters = await processModule({
          context: { format: 'module' },
          nonEvaluating: true,
          path: source,
        })

        assert.deepStrictEqual([...setters.keys()], ['value'])
        assert.strictEqual(fs.existsSync(marker), false)
      } finally {
        fs.rmSync(directory, { force: true, recursive: true })
      }
    })

    it('does not evaluate re-exported ESM modules during discovery', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-'))
      const marker = path.join(directory, 'evaluated')
      const source = path.join(directory, 'module.mjs')
      const reexport = path.join(directory, 'reexport.mjs')
      fs.writeFileSync(source, "export * from './reexport.mjs'")
      fs.writeFileSync(reexport, [
        "import fs from 'node:fs'",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'yes')`,
        'export const value = 1',
      ].join('; '))

      try {
        const setters = await processModule({
          context: { format: 'module' },
          nonEvaluating: true,
          path: source,
        })

        assert.deepStrictEqual([...setters.keys()], ['value'])
        assert.strictEqual(fs.existsSync(marker), false)
      } finally {
        fs.rmSync(directory, { force: true, recursive: true })
      }
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
