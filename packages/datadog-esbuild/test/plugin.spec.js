'use strict'

const assert = require('node:assert/strict')
const { dirname } = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const ddPlugin = require('../index')

function captureOptionalPeerOnLoad () {
  let onLoad
  ddPlugin.setup({
    initialOptions: {},
    onResolve () {},
    onLoad (options, callback) {
      if (options.filter.source.includes('require-provider')) onLoad = callback
    },
  })
  return onLoad
}

function captureOnResolve () {
  let onResolve
  ddPlugin.setup({
    initialOptions: {},
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
 * @param {object} [plugin]
 * @param {object} [initialOptions]
 * @returns {{ onLoad: Function, onResolve: Function }}
 */
function captureModuleHooks (resolve, plugin = ddPlugin, initialOptions = {}) {
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
    const onResolve = captureOnResolve()

    const result = onResolve({
      path: 'fs',
      resolveDir: process.cwd(),
      kind: 'require-call',
      namespace: 'file',
      importer: '/app/index.js',
    })

    assert.strictEqual(result, undefined)
  })

  describe('IITM wrappers', () => {
    it('resolves package formats and leaves IITM adapter resolution alone', () => {
      const modulesOfInterest = new Set(['express'])
      const plugin = proxyquire('../index', {
        '../datadog-instrumentations/src/helpers/bundler-modules': modulesOfInterest,
      })
      const { onResolve } = captureModuleHooks(undefined, plugin)
      const result = onResolve({
        path: 'express',
        resolveDir: process.cwd(),
        kind: 'require-call',
        namespace: 'file',
        importer: `${process.cwd()}/index.js`,
      })

      assert.strictEqual(result.pluginData.format, 'commonjs')
      assert.strictEqual(result.sideEffects, true)
      assert.strictEqual(onResolve({
        path: 'express',
        pluginData: { skipDatadogInstrumentation: true },
      }), undefined)
    })

    it('maps ESM wrapper imports through the bundler', async () => {
      const { onLoad, onResolve } = captureModuleHooks()
      const path = require.resolve('./resources/export-method.mjs')
      const wrapperPath = `${path}._dd_esbuild_intercepted`
      const args = {
        path: wrapperPath,
        pluginData: {
          pkg: 'test-package',
          path: 'index.mjs',
          raw: 'test-package',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      }

      const result = await onLoad(args)

      assert.match(result.contents, /from "\.\/__iitm_runtime__\.js"/)
      assert.match(result.contents, /registerWithData/)
      assert.doesNotMatch(result.contents, /import-in-the-middle\/lib\/register\.js/)

      const runtime = await onResolve({
        path: './__iitm_runtime__.js',
        importer: wrapperPath,
        namespace: 'file',
        resolveDir: '',
        kind: 'import-statement',
      })
      assert.match(runtime.path, /\/lib\/bundler-runtime\.js$/)
      assert.strictEqual(runtime.sideEffects, true)
    })

    it('resolves and loads ESM re-exports through the esbuild adapter', async () => {
      const nestedPath = require.resolve('./resources/export-method.mjs')
      const path = require.resolve('./resources/export-method-and-nested-method.mjs')
      const wrapperPath = `${path}._dd_esbuild_intercepted`
      const { onLoad, onResolve } = captureModuleHooks(async (specifier, options) => {
        assert.strictEqual(specifier, pathToFileURL(nestedPath).href)
        assert.strictEqual(options.pluginData.skipDatadogInstrumentation, true)
        return { errors: [], path: nestedPath }
      })
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          pkg: 'test-package',
          path: 'index.mjs',
          raw: 'test-package',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /exportedMethod2/)
      assert.ok(result.watchFiles.includes(nestedPath))

      const nested = await onResolve({
        path: './__iitm_module_0__.js',
        importer: wrapperPath,
      })
      assert.strictEqual(nested.path, path)

      const runtime = await onResolve({
        path: './__iitm_runtime__.js',
        importer: wrapperPath,
      })
      assert.match(runtime.path, /\/lib\/bundler-runtime\.js$/)
    })

    it('resolves builtin re-exports through the adapter', async () => {
      const path = require.resolve('./resources/reexport-builtin.mjs')
      const wrapperPath = `${path}._dd_esbuild_intercepted`
      const { onLoad } = captureModuleHooks()
      const result = await onLoad({
        path: wrapperPath,
        pluginData: {
          pkg: 'test-package',
          path: 'index.mjs',
          raw: 'test-package',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: true,
          format: 'module',
        },
      })

      assert.match(result.contents, /\$readFile/)
    })

    it('loads the original ESM module after its wrapper', async () => {
      const { onLoad } = captureModuleHooks()
      const path = require.resolve('./resources/export-method.mjs')
      const result = await onLoad({
        path,
        pluginData: {
          pkgOfInterest: true,
          isESM: true,
        },
      })

      assert.match(result.contents, /export function exportMethod/)
      assert.strictEqual(result.resolveDir, dirname(path))
    })

    it('routes CommonJS replacements through IITM', async () => {
      const { onLoad } = captureModuleHooks()
      const path = require.resolve('../src/log')
      const result = await onLoad({
        path,
        pluginData: {
          pkg: 'test-package',
          path: 'index.js',
          raw: 'test-package',
          version: '1.0.0',
          pkgOfInterest: true,
          isESM: false,
          format: 'commonjs',
        },
      })

      assert.match(result.contents, /registerCommonJS/)
      assert.doesNotMatch(result.contents, /dd-trace:bundler:load/)
    })

    it('routes builtin ESM imports through IITM', async () => {
      const modulesOfInterest = new Set(['node:http'])
      const plugin = proxyquire('../index', {
        '../datadog-instrumentations/src/helpers/bundler-modules': modulesOfInterest,
      })
      const { onLoad, onResolve } = captureModuleHooks(undefined, plugin, { format: 'esm' })
      const result = onResolve({
        path: 'node:http',
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
      assert.strictEqual(wrapper.resolveDir, process.cwd())

      const original = await onResolve({
        path: './__iitm_module_0__.js',
        importer: result.path,
      })
      assert.strictEqual(original.path, 'node:http')
      assert.strictEqual(original.external, true)
      assert.strictEqual(original.sideEffects, true)
    })
  })

  describe('optional peer bundling', () => {
    it('rewrites the installed peer load in require-provider into a literal require', () => {
      const onLoad = captureOptionalPeerOnLoad()
      const providerPath = require.resolve('../../dd-trace/src/openfeature/require-provider')

      const result = onLoad({ path: providerPath })

      assert.ok(result.contents.includes("require('@datadog/openfeature-node-server')"), 'should inline the peer')
      assert.ok(
        !result.contents.includes("requireOptionalPeer('@datadog/openfeature-node-server')"),
        'should drop the opaque load'
      )
    })

    it('ignores files that match the filter but are not an optional-peer file', () => {
      const onLoad = captureOptionalPeerOnLoad()

      assert.strictEqual(onLoad({ path: '/somewhere/else/require-provider.js' }), undefined)
    })
  })
})
