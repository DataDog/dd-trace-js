import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { supportsSyncHooks } from 'import-in-the-middle/create-hook.mjs'
import { before, describe, it } from 'mocha'

const require = createRequire(import.meta.url)
const source = 'export function getTracer () { return "tracer" }\n'
const commonJSSource = 'function getTracer () { return "tracer" }\nmodule.exports = { getTracer }\n'
const strictCommonJSSource = `'use strict'
${commonJSSource}//# sourceMappingURL=data:application/json;base64,e30=
`
const decoratedCommonJSSource = `#!/usr/bin/env node\n${strictCommonJSSource}`
const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, '../../../../..')
const jasmineSourcePath = resolve(testDirectory, '../../fixtures/webdriverio-jasmine-framework.mjs')
const jasmineModulePath = resolve(
  testDirectory,
  '../../fixtures/node_modules/@wdio/jasmine-framework/build/index.js'
)
const originalCompileSymbol = 'dd-trace.test.rewriter.original-compile'
const rewrittenForCompileSymbolName = 'dd-trace.loader.rewritten-for-compile'
const rewrittenForCompileSymbol = Symbol.for(rewrittenForCompileSymbolName)
const instrumentationsEntryPath = join(repositoryRoot, 'packages', 'datadog-instrumentations')
const rewriterLoaderPath = join(instrumentationsEntryPath, 'src', 'helpers', 'rewriter', 'loader')
const supportsRegisterHooks = typeof require('node:module').registerHooks === 'function'
const coverageNodeOptions = process.env.NYC_PROCESS_ID ? process.env.NODE_OPTIONS : undefined
const registerNodeOptions = [
  coverageNodeOptions,
  `--import ${join(repositoryRoot, 'register.js')}`,
].filter(Boolean).join(' ')
// Below this, `module.registerHooks` either does not exist or predates
// nodejs/node#59929, so every loader path falls back to the compile hook.
const supportsSynchronousLoader = supportsSyncHooks()

describe('rewriter loader', () => {
  let load
  let loadSync

  before(async () => {
    // require(esm) keeps the loader on nyc's CommonJS instrumentation path so its
    // transforms count as covered. Without require(esm), nyc's .mjs require extension
    // feeds the module to the CommonJS compiler, which throws on its ESM `import`.
    // The property is absent (undefined) before Node 20.19/22.10, which is the false branch.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const rewriterLoader = process.features.require_module
      ? require('../../../src/helpers/rewriter/loader.mjs')
      : await import('../../../src/helpers/rewriter/loader.mjs')
    load = rewriterLoader.load
    loadSync = rewriterLoader.loadSync
  })

  it('does not load the rewriter for dependencies without targets', () => {
    const loaderUrl = pathToFileURL(join(testDirectory, '../../../src/helpers/rewriter/loader.mjs')).href
    const rewriterPath = join(testDirectory, '../../../src/helpers/rewriter/index.js')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { createRequire } from 'node:module'

      const require = createRequire(import.meta.url)
      const rewriterPath = require.resolve(${JSON.stringify(rewriterPath)})
      const { load } = await import(${JSON.stringify(loaderUrl)})
      const result = await load('file:///app/node_modules/example/index.mjs', { format: 'module' }, () => ({
        format: 'module',
        source: ${JSON.stringify(source)},
      }))

      console.log(result.source === ${JSON.stringify(source)})
      console.log(require.cache[rewriterPath] === undefined)
    `], {
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, 'true\ntrue\n')
  })

  it('does not eagerly load the rewriter when the compile wrapper is required', () => {
    const loaderPath = join(testDirectory, '../../../src/helpers/rewriter/loader.js')
    const rewriterPath = join(testDirectory, '../../../src/helpers/rewriter/index.js')
    const result = spawnSync(process.execPath, ['--eval', `
      const rewriterPath = require.resolve(${JSON.stringify(rewriterPath)})
      require(${JSON.stringify(loaderPath)})
      console.log(require.cache[rewriterPath] === undefined)
    `], {
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, 'true\n')
  })

  it('does not rewrite application modules', async () => {
    const result = await load('file:///app.mjs', { format: 'module' }, () => ({ format: 'module', source }))

    assert.strictEqual(result.source, source)
  })

  it('does not rewrite dependencies without targets', async () => {
    const result = await load(
      'file:///app/node_modules/example/index.mjs',
      { format: 'module' },
      () => ({ format: 'module', source })
    )

    assert.strictEqual(result.source, source)
  })

  it('does not rewrite results without source', async () => {
    const result = await load(createAiModuleUrl(), { format: 'module' }, () => ({ format: 'module' }))

    assert.deepStrictEqual(result, { format: 'module' })
  })

  it('rewrites async loader results', async () => {
    const url = createAiModuleUrl()
    const result = await load(url, { format: 'module' }, () => ({ format: 'module', source }))

    assertRewritten(result.source)
  })

  it('rewrites sync loader results', () => {
    const url = createAiModuleUrl()
    const result = loadSync(url, { format: 'module' }, () => ({ format: 'module', source }))

    assertRewritten(result.source)
  })

  it('rewrites binary sync loader results', () => {
    const sourceText = readFileSync(jasmineSourcePath, 'utf8')
    const buffer = Buffer.from(sourceText)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    const sources = [
      buffer,
      arrayBuffer,
      new Uint8Array(arrayBuffer),
    ]

    for (const binarySource of sources) {
      const result = loadSync(
        pathToFileURL(jasmineModulePath).href,
        { format: 'module' },
        () => ({ format: 'module', source: binarySource })
      )

      assert.match(result.source, /orchestrion:@wdio\/jasmine-framework:JasmineAdapter_init/)
      assert.match(result.source, /orchestrion:@wdio\/jasmine-framework:JasmineReporter_specStarted/)
    }
  })

  it('keeps CommonJS async loader results unchanged', async () => {
    const url = createAiModuleUrl()
    const result = await load(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource })
    )
    const resultFromConditions = await load(
      url,
      { conditions: ['require'] },
      () => ({ source: commonJSSource })
    )

    assert.strictEqual(result.source, commonJSSource)
    assert.strictEqual(resultFromConditions.source, commonJSSource)
  })

  it('rewrites CommonJS sync loader results', () => {
    const url = createAiModuleUrl()
    const result = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource })
    )
    const resultFromContext = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ source: commonJSSource })
    )
    const resultFromConditions = loadSync(
      url,
      { conditions: ['require'] },
      () => ({ source: decoratedCommonJSSource })
    )

    assertCommonJSRewritten(result.source)
    assertCommonJSRewritten(resultFromContext.source)
    assertCommonJSRewritten(resultFromConditions.source)
  })

  it('decodes percent-encoded file URLs before rewriting CommonJS', () => {
    const url = createAiModuleUrlWithSpace()

    const result = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource })
    )

    assertCommonJSRewritten(result.source)
  })

  it('marks rewritten CommonJS for the compiler to pass through', () => {
    const url = createAiModuleUrl()

    loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource })
    )

    assert.strictEqual(globalThis[rewrittenForCompileSymbol].delete(fileURLToPath(url)), true)
  })

  it('keeps nullish CommonJS source unchanged for the compile fallback', () => {
    const url = createAiModuleUrl()
    const result = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: undefined })
    )

    assert.deepStrictEqual(result, { format: 'commonjs', source: undefined })
    assert.strictEqual(globalThis[rewrittenForCompileSymbol]?.has(fileURLToPath(url)) ?? false, false)
  })

  it('does not restore the hashbang, which would shift every source map mapping', () => {
    const url = createAiModuleUrl()
    const withHashbang = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ source: decoratedCommonJSSource })
    )
    const withoutHashbang = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ source: strictCommonJSSource })
    )

    assert.doesNotMatch(withHashbang.source, /^#!/)
    // Orchestrion emits the same line count either way, so an extra hashbang line
    // would desynchronise the generated source map from the emitted source.
    assert.strictEqual(withHashbang.source.split('\n').length, withoutHashbang.source.split('\n').length)
  })

  it('rewrites ESM loaded through require in the sync loader', () => {
    const result = loadSync(
      createAiModuleUrl(),
      { conditions: ['require'] },
      () => ({ format: 'module', source })
    )

    assertRewritten(result.source)
  })

  it('trusts an ESM result format over the require condition', () => {
    const result = loadSync(
      createAiModuleUrl(),
      { conditions: ['require'] },
      () => ({ format: 'module', source })
    )

    assertRewritten(result.source)
  })

  it('rewrites a CommonJS package once with the compile hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), decoratedCommonJSSource)
    writeCompileCapture(root)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      const compile = Module.prototype._compile
      const aiPath = require.resolve('ai')
      let starts = 0
      let sourceMarked

      channel.subscribe({ start () { starts++ } })
      Module.prototype._compile = function (content, filename, format) {
        if (filename === aiPath) {
          const rewritten = globalThis[Symbol.for(${JSON.stringify(rewrittenForCompileSymbolName)})]
          sourceMarked = rewritten?.has(filename) ?? false
        }
        return compile.call(this, content, filename, format)
      }
      const value = require('ai').getTracer()
      require(${JSON.stringify(join(repositoryRoot, 'packages', 'datadog-instrumentations'))})
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        sourceMarked,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'capture-compile.cjs')}`,
        `--import ${join(repositoryRoot, 'register.js')}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      sourceMarked: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('does not rewrite twice when the compile shim is installed before the sync loader', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    // The entrypoint hook and full synchronous loader can both see this module.
    // Only the outer full loader rewrites it, and the compile fallback passes the
    // marked result through.
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-preloaded-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    writeCompileCapture(root)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'capture-compile.cjs')}`,
        `--require ${rewriterLoaderPath}`,
        `--import ${join(repositoryRoot, 'register.js')}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('rewrites CommonJS imported from ESM under the asynchronous loader', function () {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-async-import-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    writeCompileCapture(root)
    writeFileSync(join(root, 'main.mjs'), `
      import { createRequire } from 'node:module'
      import ai from 'ai'

      const require = createRequire(import.meta.url)
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = ai.getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    // The configuration every ESM plugin integration test runs. The asynchronous
    // loader owns the ESM graph and reports no source for the CommonJS modules it
    // pulls into it, so the entrypoint has to stay on the compile shim here.
    const result = runFixture(root, 'main.mjs', {
      NODE_OPTIONS: [
        `--require ${join(root, 'capture-compile.cjs')}`,
        `--require ${rewriterLoaderPath}`,
        `--experimental-loader ${join(repositoryRoot, 'loader-hook.mjs')}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('rewrites CommonJS from the entrypoint hook without a preloaded loader', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-entrypoint-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), decoratedCommonJSSource)
    writeCompileCapture(root)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'capture-compile.cjs')}`,
        `--require ${rewriterLoaderPath}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('rewrites CommonJS entrypoint loads from the entrypoint hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-entrypoint-main-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })

      function getTracer () { return 'tracer' }
      const value = getTracer()
      console.log(JSON.stringify({ starts, value }))
    `)

    const result = runFixture(root, join(packageDirectory, 'dist', 'index.js'), {
      NODE_OPTIONS: `--require ${rewriterLoaderPath}`,
    })

    assert.deepStrictEqual(result, { starts: 1, value: 'tracer' })
  })

  it('rewrites ESM required from CommonJS from the entrypoint hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = writeEsmAiPackage('dd-rewriter-loader-entrypoint-require-esm-')

    writeFileSync(join(root, 'main.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({ starts, value }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: `--require ${rewriterLoaderPath}`,
    })

    assert.deepStrictEqual(result, { starts: 1, value: 'tracer' })
  })

  it('rewrites CommonJS imported from ESM from the entrypoint hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-entrypoint-import-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    writeFileSync(join(root, 'main.mjs'), `
      import { createRequire } from 'node:module'

      const require = createRequire(import.meta.url)
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const compile = Module.prototype._compile
      const aiPath = require.resolve('ai')
      let starts = 0
      let sourceMarked

      channel.subscribe({ start () { starts++ } })
      Module.prototype._compile = function (content, filename, format) {
        if (filename === aiPath) {
          const rewritten = globalThis[Symbol.for(${JSON.stringify(rewrittenForCompileSymbolName)})]
          sourceMarked = rewritten?.has(filename) ?? false
        }
        return compile.call(this, content, filename, format)
      }
      const { default: ai } = await import('ai')
      const value = ai.getTracer()
      console.log(JSON.stringify({ sourceMarked, starts, value }))
    `)

    const result = runFixture(root, 'main.mjs', {
      NODE_OPTIONS: `--require ${rewriterLoaderPath}`,
    })

    assert.deepStrictEqual(result, { sourceMarked: true, starts: 1, value: 'tracer' })
  })

  it('leaves imported ESM to the loader when only the entrypoint hook is installed', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = writeEsmAiPackage('dd-rewriter-loader-entrypoint-import-esm-')

    writeFileSync(join(root, 'main.mjs'), `
      import { createRequire } from 'node:module'

      const require = createRequire(import.meta.url)
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const { getTracer } = await import('ai')
      const value = getTracer()
      console.log(JSON.stringify({ starts, value }))
    `)

    const result = runFixture(root, 'main.mjs', {
      NODE_OPTIONS: `--require ${rewriterLoaderPath}`,
    })

    assert.deepStrictEqual(result, { starts: 0, value: 'tracer' })
  })

  it('falls back to the compile hook on runtimes below the load hook fix', function () {
    if (!supportsRegisterHooks) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-unfixed-runtime-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    // Node 24.0.0 ships registerHooks but predates nodejs/node#59929, so a load
    // hook there throws ERR_INVALID_RETURN_PROPERTY_VALUE on the nullish
    // CommonJS source Node reports for builtins.
    writeFileSync(join(root, 'spoof-runtime.cjs'), `
      const Module = require('node:module')
      Object.defineProperty(process.versions, 'node', { value: '24.0.0' })
      globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})] = Module.prototype._compile
    `)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      require('node:zlib')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'spoof-runtime.cjs')}`,
        `--require ${rewriterLoaderPath}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('falls back to the compile hook on the last Electron without the validator fix', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-electron-unfixed-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    // Electron's `electron:electron` modules make Node's load hook validation
    // throw on the default step, so the hook must not be installed there.
    writeElectronSpoof(root, '42.8.1')
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'spoof-electron.cjs')}`,
        `--require ${rewriterLoaderPath}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('installs the load hook on the first Electron with the validator fix', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-electron-fixed-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), decoratedCommonJSSource)
    // Electron 43.0.0 exempts `electron:` URLs from the strict source validation
    // that rejects the load hook below it, so the hook is installed again.
    writeElectronSpoof(root, '43.0.0')
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'spoof-electron.cjs')}`,
        `--require ${rewriterLoaderPath}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('falls back to the compile hook without Module.registerHooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-fallback-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), decoratedCommonJSSource)
    writeFileSync(join(root, 'remove-register-hooks.cjs'), `
      const Module = require('node:module')
      delete Module.registerHooks
      globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})] = Module.prototype._compile
    `)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      console.log(JSON.stringify({
        compileChanged: Module.prototype._compile !== originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'remove-register-hooks.cjs')}`,
        `--require ${rewriterLoaderPath}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileChanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('rewrites CommonJS entrypoint loads in the sync loader hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-entrypoint-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })

      function getTracer () { return 'tracer' }
      const value = getTracer()
      console.log(JSON.stringify({ starts, value }))
    `)

    const result = runFixture(root, join(packageDirectory, 'dist', 'index.js'), {
      NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
    })

    assert.deepStrictEqual(result, { starts: 1, value: 'tracer' })
  })

  it('rewrites CommonJS imported from ESM in the sync loader hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-sync-import-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), commonJSSource)
    writeFileSync(join(root, 'main.mjs'), `
      import { createRequire } from 'node:module'

      const require = createRequire(import.meta.url)
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const compile = Module.prototype._compile
      const aiPath = require.resolve('ai')
      let starts = 0
      let sourceMarked

      channel.subscribe({ start () { starts++ } })
      Module.prototype._compile = function (content, filename, format) {
        if (filename === aiPath) {
          const rewritten = globalThis[Symbol.for(${JSON.stringify(rewrittenForCompileSymbolName)})]
          sourceMarked = rewritten?.has(filename) ?? false
        }
        return compile.call(this, content, filename, format)
      }
      const { default: ai } = await import('ai')
      const value = ai.getTracer()
      console.log(JSON.stringify({ sourceMarked, starts, value }))
    `)

    // import-in-the-middle clears the source of a CommonJS module it pulls into its
    // ESM graph. The compile shim rewrites the source when Node loads it through
    // the native CommonJS path.
    const result = runFixture(root, 'main.mjs', {
      NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
    })

    assert.deepStrictEqual(result, { sourceMarked: false, starts: 1, value: 'tracer' })
  })

  it('rewrites ESM modules loaded from CommonJS in the sync loader hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-esm-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","type":"module","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), source)
    writeFileSync(join(root, 'main.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      require('ai').getTracer()
      console.log(starts)
    `)

    const result = spawnSync(process.execPath, [join(root, 'main.js')], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: registerNodeOptions,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout.trim(), '1')
  })
})

function createAiModuleUrl () {
  const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-'))
  const packageDirectory = join(root, 'node_modules', 'ai')

  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')

  return pathToFileURL(join(packageDirectory, 'dist', 'index.mjs')).href
}

function createAiModuleUrlWithSpace () {
  const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-'))
  const spacedRoot = join(root, 'app name')
  const packageDirectory = join(spacedRoot, 'node_modules', 'ai')

  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')

  return pathToFileURL(join(packageDirectory, 'dist', 'index.mjs')).href
}

function assertRewritten (rewrittenSource) {
  assert.match(rewrittenSource, /from "file:\/\/.+dc-polyfill/)
  assert.match(rewrittenSource, /tr_ch_apm_tracingChannel/)
  assert.match(rewrittenSource, /orchestrion:ai:getTracer/)
}

function assertCommonJSRewritten (rewrittenSource) {
  assert.match(rewrittenSource, /require\(".*dc-polyfill/)
  assert.match(rewrittenSource, /tr_ch_apm_tracingChannel/)
  assert.match(rewrittenSource, /orchestrion:ai:getTracer/)
}

function writeEsmAiPackage (prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const packageDirectory = join(root, 'node_modules', 'ai')

  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","type":"module","main":"dist/index.js"}')
  writeFileSync(join(packageDirectory, 'dist', 'index.js'), source)

  return root
}

function writeElectronSpoof (root, version) {
  writeFileSync(join(root, 'spoof-electron.cjs'), `
    const Module = require('node:module')
    Object.defineProperty(process.versions, 'electron', { value: ${JSON.stringify(version)} })
    globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})] = Module.prototype._compile
  `)
}

function writeCompileCapture (root) {
  writeFileSync(join(root, 'capture-compile.cjs'), `
    const Module = require('node:module')
    globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})] = Module.prototype._compile
  `)
}

function runFixture (root, entrypoint = 'main.js', environment = {}) {
  if (environment.NODE_OPTIONS) {
    environment.NODE_OPTIONS = [coverageNodeOptions, environment.NODE_OPTIONS].filter(Boolean).join(' ')
  }

  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      OTEL_LOGS_EXPORTER: '',
      OTEL_METRICS_EXPORTER: '',
      OTEL_TRACES_EXPORTER: '',
      ...environment,
    },
    encoding: 'utf8',
  })

  assert.strictEqual(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}
