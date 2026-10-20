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
    onStart () {},
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

function captureOnResolve () {
  let onResolve
  ddPlugin.setup({
    initialOptions: {},
    onStart () {},
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

  describe('git metadata injection', () => {
    const original = process.env.DD_BUNDLER_INJECT_GIT_METADATA
    const pluginPath = require.resolve('../index')

    afterEach(() => {
      if (original === undefined) {
        delete process.env.DD_BUNDLER_INJECT_GIT_METADATA
      } else {
        process.env.DD_BUNDLER_INJECT_GIT_METADATA = original
      }
      delete require.cache[pluginPath]
    })

    it('skips banner injection when DD_BUNDLER_INJECT_GIT_METADATA=false', () => {
      process.env.DD_BUNDLER_INJECT_GIT_METADATA = 'false'
      delete require.cache[pluginPath]
      const plugin = require('../index')
      const initialOptions = { banner: { js: '// existing\n' } }
      plugin.setup({
        initialOptions,
        onStart () {},
        onEnd () {},
        onResolve () {},
        onLoad () {},
      })
      assert.equal(initialOptions.banner.js.includes('DD_GIT_COMMIT_SHA'), false)
      assert.equal(initialOptions.banner.js.includes('DD_GIT_REPOSITORY_URL'), false)
    })
  })
})
