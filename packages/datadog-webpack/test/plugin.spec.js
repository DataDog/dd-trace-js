'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')

describe('DatadogWebpackPlugin', () => {
  describe('apply', () => {
    it('throws when minimize is enabled', () => {
      const plugin = new DatadogWebpackPlugin()
      let environmentHook
      const compiler = {
        options: {
          optimization: { minimize: true },
        },
        hooks: {
          environment: { tap: (name, fn) => { environmentHook = fn } },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: { tap: () => {} },
        },
      }

      plugin.apply(compiler)
      assert.throws(
        () => environmentHook(),
        /optimization\.minimize is not compatible/
      )
    })

    it('does not throw when minimize is not enabled', () => {
      const plugin = new DatadogWebpackPlugin()
      const tapped = []
      const compiler = {
        options: {
          optimization: { minimize: false },
        },
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: {
            tap: (name, fn) => { tapped.push(name) },
          },
        },
      }

      plugin.apply(compiler)
      assert.equal(tapped[0], 'DatadogWebpackPlugin')
    })

    describe('git metadata injection', () => {
      const pluginPath = require.resolve('../index')
      const original = process.env.DD_BUNDLER_INJECT_GIT_METADATA

      afterEach(() => {
        if (original === undefined) {
          delete process.env.DD_BUNDLER_INJECT_GIT_METADATA
        } else {
          process.env.DD_BUNDLER_INJECT_GIT_METADATA = original
        }
        delete require.cache[pluginPath]
      })

      function applyAndProcessAssets (Plugin) {
        let processAssets
        const source = 'module.exports = 1\n'
        let asset
        const compilation = {
          chunks: [
            {
              canBeInitial: () => false,
              files: new Set(['lazy.js']),
            },
            {
              canBeInitial: () => true,
              files: new Set(['bundle.js', 'notes.txt', 'bundle.mjs']),
            },
          ],
          hooks: {
            processAssets: {
              tap: (_options, fn) => { processAssets = fn },
            },
          },
          updateAsset (filename, fn) {
            const previous = { source: () => source, map: () => null }
            asset = { filename, value: fn(previous) }
          },
        }
        const plugin = new Plugin()
        plugin.apply({
          options: { optimization: { minimize: false } },
          hooks: {
            environment: { tap: () => {} },
            thisCompilation: { tap: (_name, fn) => fn(compilation) },
            normalModuleFactory: { tap: () => {} },
          },
        })
        processAssets?.()
        return asset
      }

      it('prefixes initial js assets with git metadata', () => {
        const asset = applyAndProcessAssets(DatadogWebpackPlugin)

        assert.ok(asset, 'expected an updated asset')
        assert.equal(asset.filename, 'bundle.mjs')
        const content = asset.value.source()
        assert.match(content, /DD_GIT_COMMIT_SHA|DD_GIT_REPOSITORY_URL/)
        assert.match(content, /module\.exports = 1\n$/)
        assert.equal(typeof asset.value.size(), 'number')
        assert.equal(asset.value.map(), null)
        assert.equal(asset.value.sourceAndMap().source, content)
        asset.value.updateHash({ update () {} })
      })

      it('skips asset rewriting when DD_BUNDLER_INJECT_GIT_METADATA=false', () => {
        process.env.DD_BUNDLER_INJECT_GIT_METADATA = 'false'
        delete require.cache[pluginPath]
        const Plugin = require('../index')
        const asset = applyAndProcessAssets(Plugin)

        assert.equal(asset, undefined)
      })
    })
  })
})

describe('loader', () => {
  it('appends dc-polyfill channel publish to module source', () => {
    const source = "'use strict'\nmodule.exports = { foo: 'bar' }"
    const options = { pkg: 'mypackage', version: '1.2.3', path: 'mypackage' }

    const context = {
      cacheable: () => {},
      getOptions: () => options,
    }

    const result = loader.call(context, source)

    // Switch to `assert.match(result, new RegExp(`^${RegExp.escape(source)}`), ...)` once the minimum supported
    // Node.js version is 24. Until then, `RegExp.escape` is unavailable and hand-escaping every regex metacharacter
    // in `source` would be more error-prone than this `startsWith` check.
    // eslint-disable-next-line eslint-rules/eslint-prefer-assert-match
    assert.ok(result.startsWith(source), 'result should start with original source')
    assert.ok(result.includes("require('dc-polyfill')"), 'result should require dc-polyfill')
    assert.ok(result.includes("'dd-trace:bundler:load'"), 'result should use the bundler channel')
    assert.ok(result.includes("version: '1.2.3'"), 'result should contain the version')
    assert.ok(result.includes("package: 'mypackage'"), 'result should contain the package name')
    assert.ok(result.includes("path: 'mypackage'"), 'result should contain the path')
    assert.ok(result.includes('module.exports = __dd_payload.module'), 'result should update module.exports')
  })

  it('uses __dd_ prefix to avoid name collisions', () => {
    const source = 'module.exports = {}'
    const options = { pkg: 'pkg', version: '1.0.0', path: 'pkg' }
    const context = {
      cacheable: () => {},
      getOptions: () => options,
    }

    const result = loader.call(context, source)

    assert.ok(result.includes('__dd_dc'), 'should use __dd_dc variable')
    assert.ok(result.includes('__dd_ch'), 'should use __dd_ch variable')
    assert.ok(result.includes('__dd_mod'), 'should use __dd_mod variable')
    assert.ok(result.includes('__dd_payload'), 'should use __dd_payload variable')
  })
})
