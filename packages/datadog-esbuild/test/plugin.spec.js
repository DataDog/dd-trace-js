'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')

const ddPlugin = require('../index')
const transformTypeScript = require('./helpers/transform-typescript')

/**
 * @param {object} [initialOptions]
 */
function captureOnLoad (initialOptions = {}) {
  let onEnd
  const onLoads = []
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
      onLoads.push({ callback, options })
    },
  })
  /** @param {object} args */
  return async function runOnLoad (args) {
    try {
      for (const { callback, options } of onLoads) {
        if (!options.filter.test(args.path)) continue
        const result = await callback(args)
        if (result !== undefined) return result
      }
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
  })

  describe('libdatadog WASM', () => {
    it('ignores marked assets outside the libdatadog WASM package', async () => {
      const fixture = createWasmFixture()
      const modulePath = path.join(fixture.directory, 'fixture.js')
      const onLoad = captureOnLoad()
      try {
        fs.copyFileSync(fixture.modulePath, modulePath)
        assert.strictEqual(await onLoad({ path: modulePath }), undefined)
      } finally {
        fs.rmSync(fixture.directory, { force: true, recursive: true })
      }
    })

    it('leaves releases without external WASM assets unchanged', async () => {
      const fixture = createWasmFixture('module.exports = Buffer.from("inline WASM")')
      const onLoad = captureOnLoad()
      try {
        assert.strictEqual(await onLoad({ path: fixture.modulePath }), undefined)
      } finally {
        fs.rmSync(fixture.directory, { force: true, recursive: true })
      }
    })

    it('inlines marked assets and watches the compressed file', async () => {
      const fixture = createWasmFixture()
      const onLoad = captureOnLoad()
      try {
        const result = await onLoad({ path: fixture.modulePath })

        assert.deepStrictEqual(result.watchFiles, [fixture.assetPath])
        assert.doesNotMatch(result.contents, /@datadog\/wasm-asset|\.wasm\.br/)
        assert.match(result.contents, /Buffer\.from\("Zml4dHVyZSBXQVNN", 'base64'\)/)
      } finally {
        fs.rmSync(fixture.directory, { force: true, recursive: true })
      }
    })

    it('fails when a marked asset is missing', async () => {
      const fixture = createWasmFixture()
      const onLoad = captureOnLoad()
      try {
        fs.rmSync(fixture.assetPath)
        await assert.rejects(onLoad({ path: fixture.modulePath }), /fixture_bg\.wasm\.br/)
      } finally {
        fs.rmSync(fixture.directory, { force: true, recursive: true })
      }
    })

    it('fails when the marked loader shape changes', async () => {
      const fixture = createWasmFixture("const bytes = loadWasm('fixture_bg.wasm.br')")
      const onLoad = captureOnLoad()
      try {
        await assert.rejects(onLoad({ path: fixture.modulePath }), /Unsupported .* asset loader/)
      } finally {
        fs.rmSync(fixture.directory, { force: true, recursive: true })
      }
    })
  })
})

/**
 * @param {string} [source]
 */
function createWasmFixture (source) {
  const dirnameExpression = '${' + '__dirname}'
  const defaultSource = 'const bytes = /* @datadog/wasm-asset */ ' +
    `require('node:fs').readFileSync(\`${dirnameExpression}/fixture_bg.wasm.br\`)`
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-wasm-'))
  const modulePath = path.join(
    directory,
    'node_modules',
    '@datadog',
    'libdatadog-wasm',
    'dist',
    'fixture.js'
  )
  const assetPath = path.join(path.dirname(modulePath), 'fixture_bg.wasm.br')
  fs.mkdirSync(path.dirname(modulePath), { recursive: true })
  fs.writeFileSync(assetPath, 'fixture WASM')
  fs.writeFileSync(modulePath, source ?? defaultSource)
  return { assetPath, directory, modulePath }
}
