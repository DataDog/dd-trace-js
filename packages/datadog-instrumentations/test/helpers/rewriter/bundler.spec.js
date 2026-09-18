'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createBundlerRewriter } = require('../../../src/helpers/rewriter')

describe('bundler rewriter', () => {
  let directory

  afterEach(() => {
    if (directory) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('composes a caller-owned source map', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-bundler-rewriter-'))
    const packageDirectory = path.join(directory, 'node_modules', 'ai')
    const filename = path.join(packageDirectory, 'dist', 'index.js')
    const source = 'function getTracer () { return {} }\nmodule.exports = { getTracer }\n'
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: '5.0.0' }))
    fs.writeFileSync(filename, source)
    const sourceMap = {
      file: filename,
      mappings: 'AAAA',
      names: [],
      sources: ['original.js'],
      sourcesContent: [source],
      version: 3,
    }

    const rewrite = createBundlerRewriter('/absolute/dc-polyfill.js')
    const result = rewrite(source, filename, 'commonjs', {
      filePath: 'dist/index.js',
      moduleName: 'ai',
    }, sourceMap)
    const map = typeof result.map === 'string' ? JSON.parse(result.map) : result.map

    assert.match(/** @type {string} */ (result.code), /tr_ch_apm_tracingChannel/)
    assert.match(/** @type {string} */ (result.code), /require\("\/absolute\/dc-polyfill\.js"\)/)
    assert.strictEqual(map.sources[0], 'original.js')
    assert.strictEqual(map.sourcesContent[0], source)
  })

  it('preserves sources and maps without a generated target', () => {
    const sourceMap = { mappings: '', version: 3 }
    const rewrite = createBundlerRewriter('/absolute/dc-polyfill.js')

    assert.deepStrictEqual(
      rewrite('', '/project/application.js', 'commonjs', undefined, sourceMap),
      { code: '', map: sourceMap }
    )
    assert.deepStrictEqual(
      rewrite('module.exports = true', '/project/application.js', 'commonjs', undefined, sourceMap),
      { code: 'module.exports = true', map: sourceMap }
    )
  })

  it('preserves sources and maps without a matching transformer', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-bundler-rewriter-'))
    const packageDirectory = path.join(directory, 'node_modules', 'unsupported')
    const filename = path.join(packageDirectory, 'index.js')
    const source = 'module.exports = true\n'
    const sourceMap = { mappings: '', version: 3 }
    fs.mkdirSync(packageDirectory, { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const rewrite = createBundlerRewriter('/absolute/dc-polyfill.js')

    assert.deepStrictEqual(
      rewrite(source, filename, 'commonjs', { filePath: 'index.js', moduleName: 'unsupported' }, sourceMap),
      { code: source, map: sourceMap }
    )
  })

  it('preserves sources and maps when transformation fails', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-bundler-rewriter-'))
    const packageDirectory = path.join(directory, 'node_modules', 'ai')
    const filename = path.join(packageDirectory, 'dist', 'index.js')
    const source = 'export function {'
    const sourceMap = { mappings: 'AAAA', version: 3 }
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: '5.0.0' }))

    const rewrite = createBundlerRewriter('/absolute/dc-polyfill.js')

    assert.deepStrictEqual(
      rewrite(source, filename, 'module', {
        filePath: 'dist/index.js',
        moduleName: 'ai',
      }, sourceMap),
      { code: source, map: sourceMap }
    )
  })
})
