'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

const ddPlugin = require('../index')

/**
 * @param {object} [initialOptions]
 * @returns {Function}
 */
function captureOnResolve (initialOptions = {}) {
  let onResolve
  ddPlugin.setup({
    initialOptions,
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onResolve (options, callback) {
      onResolve = callback
    },
    onLoad () {},
  })
  return onResolve
}

/**
 * @param {Function} [resolve]
 * @param {object} [initialOptions]
 * @param {object} [plugin]
 * @returns {{ onLoad: Function, onResolve: Function }}
 */
function captureModuleHooks (resolve, initialOptions = {}, plugin = ddPlugin) {
  let onResolve
  let onLoad
  plugin.setup({
    initialOptions,
    resolve,
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onResolve (options, callback) {
      onResolve = callback
    },
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onLoad (options, callback) {
      if (options.filter.source === '.*') onLoad = callback
    },
  })
  return { onLoad, onResolve }
}

describe('datadog-esbuild plugin', () => {
  it('ignores builtins without a package path', () => {
    for (const initialOptions of [{}, { format: 'esm' }]) {
      const onResolve = captureOnResolve(initialOptions)
      for (const builtin of ['fs', 'node:fs', 'node:test']) {
        const result = onResolve({
          path: builtin,
          resolveDir: process.cwd(),
          kind: 'require-call',
          namespace: 'file',
          importer: '/app/index.js',
        })

        assert.strictEqual(result, undefined)
      }
    }

    const onResolve = captureOnResolve({ format: 'esm' })
    const result = onResolve({
      path: '_http_agent',
      resolveDir: process.cwd(),
      kind: 'import-statement',
      namespace: 'file',
      importer: '/app/index.mjs',
    })
    assert.strictEqual(result, undefined)
  })

  it('leaves local scoped aliases and application imports uninstrumented', () => {
    const onResolve = captureOnResolve()
    for (const request of ['@scope', '@scope/local', '@scope/local/subpath']) {
      const result = onResolve({
        importer: '/app/index.js',
        kind: 'import-statement',
        namespace: 'file',
        path: request,
        resolveDir: '/app',
      })
      assert.strictEqual(result, undefined)
    }

    const result = onResolve({
      importer: '/app/index.js',
      kind: 'import-statement',
      namespace: 'file',
      path: './resources/export-method.mjs',
      resolveDir: __dirname,
    })
    assert.strictEqual(result.pluginData.applicationFile, true)
  })

  it('does not instrument module I/O requested by IITM', () => {
    const { onResolve } = captureModuleHooks()

    const result = onResolve({
      path: 'graphql',
      pluginData: { skipDatadogInstrumentation: true },
    })

    assert.strictEqual(result, undefined)
  })

  it('resolves linked instrumented packages outside node_modules', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-linked-'))
    try {
      const applicationDirectory = path.join(directory, 'app')
      const packageDirectory = path.join(directory, 'packages/graphql')
      const resource = path.join(packageDirectory, 'execution/execute.mjs')
      fs.mkdirSync(path.dirname(resource), { recursive: true })
      fs.mkdirSync(path.join(applicationDirectory, 'node_modules'), { recursive: true })
      fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name: 'graphql',
        version: '17.0.0',
      }))
      fs.writeFileSync(resource, 'export function execute () {}')
      fs.symlinkSync(packageDirectory, path.join(applicationDirectory, 'node_modules/graphql'), 'dir')
      const { onResolve } = captureModuleHooks()

      const result = onResolve({
        importer: path.join(applicationDirectory, 'index.js'),
        kind: 'import-statement',
        namespace: 'file',
        path: 'graphql/execution/execute.mjs',
        resolveDir: applicationDirectory,
      })

      assert.strictEqual(result.pluginData.pkg, 'graphql')
      assert.strictEqual(result.pluginData.path, 'execution/execute.mjs')
      assert.strictEqual(result.pluginData.version, '17.0.0')
    } finally {
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  describe('IITM wrappers', () => {
    it('maps ESM wrapper imports through esbuild', async () => {
      const { onLoad, onResolve } = captureModuleHooks()
      const modulePath = require.resolve('./resources/export-method.mjs')
      const wrapperPath = `${modulePath}._dd_esbuild_intercepted`
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          moduleName: 'fixture',
          pkg: 'fixture',
          path: 'index.mjs',
          raw: 'fixture',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /registerWithData/)
      assert.match(result.contents, /"moduleName":"fixture"/)
      assert.doesNotMatch(result.contents, /import-in-the-middle\/lib\/register\.js/)
      assert.strictEqual(result.resolveDir, path.dirname(modulePath))

      const runtime = await onResolve({
        path: './__iitm_runtime__.js',
        importer: wrapperPath,
      })
      assert.match(runtime.path, /\/lib\/bundler-runtime\.js$/)
      assert.strictEqual(runtime.sideEffects, true)

      const original = await onResolve({
        path: './__iitm_module_0__.js',
        importer: wrapperPath,
      })
      assert.strictEqual(original.path, modulePath)
    })

    it('wraps typeless ESM without assuming CommonJS', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-typeless-'))
      try {
        const modulePath = path.join(directory, 'index.js')
        fs.writeFileSync(modulePath, 'export function typelessEsm () {}')
        const { onLoad, onResolve } = captureModuleHooks()
        const result = await onLoad({
          path: modulePath,
          pluginData: {
            format: undefined,
            full: modulePath,
            internal: false,
            isESM: false,
            moduleName: 'fixture',
            path: 'index.js',
            pkg: 'fixture',
            pkgOfInterest: true,
            raw: 'fixture',
            version: '1.0.0',
          },
        })

        assert.match(result.contents, /registerWithData/)
        const original = await onResolve({
          path: './__iitm_module_0__.js',
          importer: modulePath,
        })
        assert.strictEqual(original.path, modulePath)
      } finally {
        fs.rmSync(directory, { force: true, recursive: true })
      }
    })

    it('resolves and loads ESM re-exports through esbuild', async () => {
      const nestedPath = require.resolve('./resources/export-method.mjs')
      const modulePath = require.resolve('./resources/export-method-and-nested-method.mjs')
      const wrapperPath = `${modulePath}._dd_esbuild_intercepted`

      /**
       * @param {string} specifier
       * @param {{ pluginData: { skipDatadogInstrumentation?: boolean } }} options
       * @returns {Promise<{ errors: object[], path: string }>}
       */
      async function resolveModule (specifier, options) {
        assert.strictEqual(specifier, pathToFileURL(nestedPath).href)
        assert.strictEqual(options.pluginData.skipDatadogInstrumentation, true)
        return { errors: [], path: nestedPath }
      }

      const { onLoad, onResolve } = captureModuleHooks(resolveModule)
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          moduleName: 'fixture/index.mjs',
          pkg: 'fixture',
          path: 'index.mjs',
          raw: 'fixture/subpath',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /exportedMethod2/)
      assert.match(result.contents, /"moduleName":"fixture\/index\.mjs"/)
      assert.ok(result.watchFiles.includes(nestedPath))

      const nested = await onResolve({
        path: './__iitm_module_0__.js',
        importer: wrapperPath,
      })
      assert.strictEqual(nested.path, modulePath)
    })

    it('propagates esbuild resolution failures from ESM re-exports', async () => {
      const modulePath = require.resolve('./resources/export-method-and-nested-method.mjs')
      const wrapperPath = `${modulePath}._dd_esbuild_intercepted`
      const { onLoad } = captureModuleHooks(async () => ({
        errors: [{ text: 'resolution failed' }],
        path: '',
      }))

      await assert.rejects(onLoad({
        path: wrapperPath,
        pluginData: {
          moduleName: 'fixture',
          pkg: 'fixture',
          path: 'index.mjs',
          raw: 'fixture',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      }), /resolution failed/)
    })

    it('maps aliases resolved by esbuild to builtins', async () => {
      const modulePath = require.resolve('./resources/reexport-alias.mjs')
      const wrapperPath = `${modulePath}._dd_esbuild_intercepted`
      let resolved = false

      /** @returns {Promise<{ errors: object[], path: string }>} */
      async function resolveModule () {
        resolved = true
        return { errors: [], path: 'node:fs' }
      }

      const { onLoad } = captureModuleHooks(resolveModule)
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          moduleName: 'fixture',
          pkg: 'fixture',
          path: 'index.mjs',
          raw: 'fixture',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /as readFile/)
      assert.strictEqual(resolved, true)
    })

    it('adapts missing module formats and parent URLs', async () => {
      const nestedPath = require.resolve('./resources/export-method.mjs')
      const nestedUrl = pathToFileURL(nestedPath).href

      /**
       * @param {{ load: Function, resolve: Function }} adapters
       * @returns {Promise<object>}
       */
      async function createWrapperModule ({ load, resolve }) {
        assert.deepStrictEqual(await resolve('nested', {}), {
          url: nestedUrl,
          format: undefined,
          watchFiles: [nestedUrl],
        })
        assert.deepStrictEqual(load(nestedUrl, {}), {
          source: Buffer.from('export function exportMethod () {}\n'),
          format: undefined,
          watchFiles: [nestedUrl],
        })
        assert.deepStrictEqual(load('node:fs', { format: 'builtin' }), { format: 'builtin' })
        return { code: '', imports: [], watchFiles: [] }
      }

      /** @param {string} url */
      function getNodeModuleFormat (url) {
        assert.match(url, /^file:/)
      }

      const plugin = proxyquire('../index', {
        'import-in-the-middle/bundler': { createWrapperModule, getNodeModuleFormat },
      })

      /**
       * @param {string} specifier
       * @param {{ importer: string, pluginData: { skipDatadogInstrumentation: boolean }, resolveDir: string }} options
       * @returns {Promise<{ errors: object[], path: string }>}
       */
      async function resolveModule (specifier, options) {
        assert.strictEqual(specifier, 'nested')
        assert.strictEqual(options.importer, '')
        assert.strictEqual(options.resolveDir, process.cwd())
        assert.strictEqual(options.pluginData.skipDatadogInstrumentation, true)
        return { errors: [], path: nestedPath }
      }

      const { onLoad, onResolve } = captureModuleHooks(resolveModule, {}, plugin)
      const result = onResolve({
        path: 'mocha',
        resolveDir: process.cwd(),
        kind: 'require-call',
        namespace: 'file',
        importer: '/app/index.js',
      })

      assert.strictEqual(result.pluginData.format, 'commonjs')
      await onLoad({ path: result.path, pluginData: result.pluginData })
    })

    it('discovers builtin re-exports through IITM', async () => {
      const modulePath = require.resolve('./resources/reexport-builtin.mjs')
      const wrapperPath = `${modulePath}._dd_esbuild_intercepted`
      const { onLoad, onResolve } = captureModuleHooks()
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          moduleName: 'fixture',
          pkg: 'fixture',
          path: 'index.mjs',
          raw: 'fixture',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /as readFile/)

      const builtin = await onResolve({
        path: './__iitm_module_0__.js',
        importer: wrapperPath,
      })
      assert.strictEqual(builtin.path, modulePath)
      assert.strictEqual(builtin.sideEffects, true)
    })

    it('routes CommonJS replacements through IITM', async () => {
      const { onLoad } = captureModuleHooks()
      const modulePath = require.resolve('../src/log')
      const result = await onLoad({
        path: modulePath,
        pluginData: {
          moduleName: 'fixture',
          pkg: 'fixture',
          path: 'index.js',
          raw: 'fixture',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: false,
          format: 'commonjs',
        },
      })

      assert.match(result.contents, /registerCommonJS/)
      assert.match(result.contents, /"moduleName":"fixture"/)
      assert.doesNotMatch(result.contents, /dd-trace:bundler:load/)
    })

    it('routes builtin ESM imports through IITM', async () => {
      const { onLoad, onResolve } = captureModuleHooks(undefined, { format: 'esm' })
      const result = onResolve({
        path: 'node:dns/promises',
        resolveDir: process.cwd(),
        kind: 'import-statement',
        namespace: 'file',
        importer: `${process.cwd()}/index.mjs`,
      })

      assert.strictEqual(result.pluginData.format, 'builtin')
      assert.strictEqual(result.sideEffects, true)

      const wrapper = await onLoad({
        path: result.path,
        pluginData: result.pluginData,
      })

      assert.match(wrapper.contents, /registerWithData/)
      assert.match(wrapper.contents, /"moduleName":"node:dns\/promises"/)
      assert.strictEqual(wrapper.resolveDir, process.cwd())

      const original = await onResolve({
        path: './__iitm_module_0__.js',
        importer: result.path,
      })
      assert.strictEqual(original.path, 'node:dns/promises')
      assert.strictEqual(original.external, true)
      assert.strictEqual(original.sideEffects, true)

      const repeated = onResolve({
        path: 'node:dns/promises',
        resolveDir: process.cwd(),
        kind: 'import-statement',
        namespace: 'file',
        importer: `${process.cwd()}/other.mjs`,
      })
      assert.strictEqual(repeated.path, result.path)
      assert.strictEqual(repeated.sideEffects, true)
    })
  })
})
