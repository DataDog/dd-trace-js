'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { describe, it } = require('mocha')

const ddPlugin = require('../index')
const transformTypeScript = require('./helpers/transform-typescript')

/**
 * @param {object} [initialOptions]
 */
function captureOnLoad (initialOptions = {}) {
  let onEnd
  let onLoad
  ddPlugin.setup({
    esbuild: { transformSync: transformTypeScript },
    initialOptions,
    /** @param {Function} callback */
    onEnd (callback) {
      onEnd = callback
    },
    onResolve () {},
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onLoad (options, callback) {
      onLoad = callback
    },
  })
  /** @param {object} args */
  return async function runOnLoad (args) {
    try {
      return await onLoad(args)
    } finally {
      await onEnd()
    }
  }
}

/**
 * @param {object} [initialOptions]
 */
function loadBuiltinWrapper (initialOptions) {
  const onLoad = captureOnLoad(initialOptions)
  return onLoad({
    path: '/_dd_esm_internal_/node:dns/promises._dd_esbuild_intercepted',
    pluginData: {
      internal: true,
      isESM: true,
      pkgOfInterest: true,
      raw: 'node:dns/promises',
    },
  })
}

/**
 * @param {object} [initialOptions]
 * @param {Function} [resolve]
 */
function captureOnResolve (initialOptions = {}, resolve) {
  /** @type {Function | undefined} */
  let onResolve
  ddPlugin.setup({
    initialOptions,
    resolve,
    onEnd () {},
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onResolve (options, callback) {
      onResolve = callback
    },
    onLoad () {},
  })
  return /** @type {Function} */ (onResolve)
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

  describe('conditional package exports', () => {
    const resolveDir = path.join(__dirname, 'resources/conditional-exports')
    const packageDir = path.join(resolveDir, 'node_modules/@smithy/core')
    const esmPath = path.join(packageDir, 'dist-es/submodules/schema/index.js')
    const cjsPath = path.join(packageDir, 'dist-cjs/submodules/schema/index.js')
    const args = {
      path: '@smithy/core/schema',
      resolveDir,
      kind: 'require-call',
      namespace: 'file',
      importer: path.join(resolveDir, 'node_modules/consumer/index.js'),
    }

    /**
     * @param {string} resolvedPath
     * @param {object} [overrides]
     */
    function resolution (resolvedPath, overrides = {}) {
      return {
        path: resolvedPath,
        namespace: 'file',
        external: false,
        errors: [],
        warnings: [],
        sideEffects: false,
        suffix: '',
        pluginData: undefined,
        ...overrides,
      }
    }

    it('aligns sibling exports with the hooked file and preserves the selected file metadata', async () => {
      const requests = []
      const selected = resolution(cjsPath, { sideEffects: true })
      const onResolve = captureOnResolve({ platform: 'node' },
        /**
         * @param {string} specifier
         * @param {{pluginData: object}} options
         */
        async (specifier, options) => {
          requests.push({ specifier, options })
          assert.strictEqual(onResolve({ ...args, pluginData: options.pluginData }), undefined)
          return specifier === args.path ? resolution(esmPath) : selected
        })

      const result = await onResolve(args)

      assert.strictEqual(result, selected)
      assert.deepStrictEqual(requests.map(
        /** @param {{specifier: string}} request */
        request => request.specifier
      ), [args.path, cjsPath])
      assert.strictEqual(result.sideEffects, true)
    })

    for (const kind of ['import-statement', 'dynamic-import', 'require-call']) {
      it(`preserves the ${kind} resolution context`, async () => {
        const onResolve = captureOnResolve({ platform: 'node' },
          /**
           * @param {string} specifier
           * @param {{kind: string, importer: string, resolveDir: string, namespace: string}} options
           */
          async (specifier, options) => {
            assert.strictEqual(options.kind, kind)
            assert.strictEqual(options.importer, args.importer)
            assert.strictEqual(options.resolveDir, resolveDir)
            assert.strictEqual(options.namespace, 'file')
            return resolution(specifier === args.path ? esmPath : cjsPath)
          })

        const result = await onResolve({ ...args, kind })

        assert.strictEqual(result.path, cjsPath)
      })
    }

    for (const [name, overrides] of [
      ['matching exports', { path: cjsPath }],
      ['external exports', { external: true }],
      ['resolver errors', { errors: [{ text: 'unresolved' }] }],
      ['virtual modules', { namespace: 'replacement' }],
      ['another package', { path: path.join(resolveDir, 'node_modules/not-instrumented/dist-es/index.js') }],
      ['plugin-owned modules', { pluginData: { replacement: true } }],
    ]) {
      it(`preserves ${name}`, async () => {
        const expected = resolution(esmPath, overrides)
        let calls = 0
        const onResolve = captureOnResolve({ platform: 'node' }, async () => {
          calls++
          return expected
        })

        const result = await onResolve(args)

        assert.strictEqual(result, expected)
        assert.strictEqual(calls, 1)
      })
    }

    for (const initialOptions of [
      { platform: 'browser' },
      { platform: 'neutral' },
      { platform: 'node', conditions: [] },
      { platform: 'node', conditions: ['node'] },
      { platform: 'node', conditions: ['module'] },
      { platform: 'node', alias: { '@smithy/core': 'replacement' } },
      { platform: 'node', alias: { '@smithy/core/schema': 'replacement' } },
    ]) {
      it(`leaves explicit resolution settings unchanged: ${JSON.stringify(initialOptions)}`, () => {
        let calls = 0
        const onResolve = captureOnResolve(initialOptions, () => { calls++ })

        const result = onResolve(args)

        assert.strictEqual(result, undefined)
        assert.strictEqual(calls, 0)
      })
    }

    it('preserves diagnostics from both resolution operations', async () => {
      const originalWarning = { text: 'original warning' }
      const selectedWarning = { text: 'selected warning' }
      const onResolve = captureOnResolve({ platform: 'node' },
        /** @param {string} specifier */
        async specifier => {
          return specifier === args.path
            ? resolution(esmPath, { warnings: [originalWarning] })
            : resolution(cjsPath, { warnings: [selectedWarning] })
        })

      const result = await onResolve(args)

      assert.deepStrictEqual(result.warnings, [originalWarning, selectedWarning])
    })

    it('forwards import attributes when the resolver provides them', async () => {
      const attributes = { type: 'json' }
      const onResolve = captureOnResolve({ platform: 'node' },
        /**
         * @param {string} specifier
         * @param {{with: Record<string, string>}} options
         */
        async (specifier, options) => {
          assert.strictEqual(options.with, attributes)
          return resolution(specifier === args.path ? esmPath : cjsPath)
        })

      const result = await onResolve({ ...args, with: attributes })

      assert.strictEqual(result.path, cjsPath)
    })

    it('leaves imports carrying another plugin data unchanged', () => {
      let calls = 0
      const onResolve = captureOnResolve({ platform: 'node' }, () => { calls++ })

      const result = onResolve({ ...args, pluginData: { owner: 'other-plugin' } })

      assert.strictEqual(result, undefined)
      assert.strictEqual(calls, 0)
    })

    it('preserves errors and metadata from resolution of the selected file', async () => {
      const expected = resolution(cjsPath, {
        errors: [{ text: 'selected file unavailable' }],
        suffix: '?selected',
        pluginData: { selected: true },
      })
      const onResolve = captureOnResolve({ platform: 'node' },
        /** @param {string} specifier */
        async specifier => specifier === args.path ? resolution(esmPath) : expected)

      const result = await onResolve(args)

      assert.strictEqual(result, expected)
    })

    for (const specifier of ['@smithy/core', '@smithy/core/client', cjsPath, 'not-instrumented', 'graphql']) {
      it(`only resolves unhooked bare exports: ${specifier}`, async () => {
        let calls = 0
        const onResolve = captureOnResolve({ platform: 'node' },
          /** @param {string} requested */
          async requested => {
            calls++
            return resolution(requested === specifier ? esmPath : cjsPath)
          })

        const result = await onResolve({ ...args, path: specifier })

        assert.strictEqual(calls, specifier === '@smithy/core' ? 2 : 0)
        if (specifier === '@smithy/core/client') {
          assert.strictEqual(result.pluginData.pkgOfInterest, true)
        }
      })
    }
  })

  describe('ESM wrappers', () => {
    it('uses the build directory to resolve imports in built-in module wrappers', async () => {
      const absWorkingDir = path.dirname(process.cwd())
      const result = await loadBuiltinWrapper({ absWorkingDir })

      assert.strictEqual(result.resolveDir, absWorkingDir)
    })

    it('defaults the build directory to the current working directory', async () => {
      const result = await loadBuiltinWrapper()

      assert.strictEqual(result.resolveDir, process.cwd())
    })

    it('uses the module directory to resolve imports in package wrappers', async () => {
      const onLoad = captureOnLoad()
      const modulePath = path.join(__dirname, 'resources/export-method.mjs')

      const result = await onLoad({
        path: `${modulePath}._dd_esbuild_intercepted`,
        pluginData: {
          internal: false,
          isESM: true,
          pkg: 'fixture',
          pkgOfInterest: true,
          raw: 'fixture',
        },
      })

      assert.strictEqual(result.resolveDir, path.dirname(modulePath))
    })

    it('generates setters for cyclic star exports', async () => {
      const onLoad = captureOnLoad()
      const modulePath = path.join(__dirname, 'resources/export-cycle-a.mjs')

      const result = await onLoad({
        path: `${modulePath}._dd_esbuild_intercepted`,
        pluginData: {
          internal: false,
          isESM: true,
          pkg: 'fixture',
          pkgOfInterest: true,
          raw: 'fixture',
        },
      })

      assert.match(result.contents, /set\["fromA"\]/)
      assert.match(result.contents, /set\["fromB"\]/)
    })

    it('generates setters for TypeScript module exports', async () => {
      const onLoad = captureOnLoad()
      const modulePath = path.join(__dirname, 'resources/typescript-export.mts')

      const result = await onLoad({
        path: `${modulePath}._dd_esbuild_intercepted`,
        pluginData: {
          internal: false,
          isESM: true,
          pkg: 'fixture',
          pkgOfInterest: true,
          raw: 'fixture',
        },
      })

      assert.match(result.contents, /set\["Client"\]/)
    })
  })
})
