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

function captureOnResolve () {
  let onResolve
  ddPlugin.setup({
    initialOptions: {},
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
  return onResolve
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

    it('publishes the activation of bundler-activated packages that no hook activates', async () => {
      const onLoad = captureOnLoad()
      const modulePath = path.join(__dirname, 'resources/export-method.mjs')
      const load = pkg => onLoad({
        path: `${modulePath}._dd_esbuild_intercepted`,
        pluginData: { internal: false, isESM: true, pkg, pkgOfInterest: true, raw: pkg, version: '7.0.0' },
      })

      const [activated, hooked] = await Promise.all([load('ai'), load('fixture')])

      const publication = '.publish({"activate":true,"package":"ai","version":"7.0.0","path":"ai"});'
      assert.ok(activated.contents.includes(`.channel("dd-trace:bundler:load")${publication}`), activated.contents)
      assert.ok(activated.contents.includes(`import $dd_dc from ${JSON.stringify(require.resolve('dc-polyfill'))};`))
      assert.doesNotMatch(hooked.contents, /dd-trace:bundler:load/)
    })
  })
})
