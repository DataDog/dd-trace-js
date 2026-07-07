'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const optionalPeerLoader = require('../src/optional-peer-loader')

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

    function applyToExternals (externals) {
      const compiler = {
        options: { optimization: {}, externals },
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: { tap: () => {} },
        },
      }
      new DatadogWebpackPlugin().apply(compiler)
      return compiler.options.externals
    }

    it('externalizes both OpenTelemetry API peers as a commonjs require', () => {
      const externals = applyToExternals()

      assert.deepStrictEqual(externals.at(-1), {
        '@opentelemetry/api': 'commonjs @opentelemetry/api',
        '@opentelemetry/api-logs': 'commonjs @opentelemetry/api-logs',
      })
    })

    it('keeps externals supplied as an array', () => {
      const externals = applyToExternals(['pg'])

      assert.ok(externals.includes('pg'), 'should preserve user externals')
      assert.ok('@opentelemetry/api' in externals.at(-1), 'should externalize @opentelemetry/api')
    })

    it('keeps a single non-array external', () => {
      const externals = applyToExternals('pg')

      assert.ok(externals.includes('pg'), 'should preserve the user external')
      assert.ok('@opentelemetry/api' in externals.at(-1), 'should externalize @opentelemetry/api')
    })
  })

  describe('optional peer bundling', () => {
    function captureAfterResolve () {
      const plugin = new DatadogWebpackPlugin()
      let afterResolve
      plugin.apply({
        options: { optimization: {} },
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: {
            tap: (name, fn) => fn({ hooks: { afterResolve: { tap: (n, f) => { afterResolve = f } } } }),
          },
        },
      })
      return afterResolve
    }

    it('applies the optional-peer loader to flagging_provider', () => {
      const createData = { resource: require.resolve('../../dd-trace/src/openfeature/flagging_provider') }

      captureAfterResolve()({ createData })

      assert.ok(
        createData.loaders?.some((entry) => entry.loader.includes('optional-peer-loader')),
        'the optional-peer loader should be applied'
      )
    })

    it('does not apply the optional-peer loader to unrelated modules', () => {
      const createData = { resource: '/app/packages/dd-trace/src/openfeature/index.js' }

      captureAfterResolve()({ createData })

      assert.strictEqual(createData.loaders, undefined)
    })

    it('ignores modules without a resolved resource', () => {
      const createData = {}

      captureAfterResolve()({ createData })

      assert.strictEqual(createData.loaders, undefined)
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

describe('optionalPeerLoader', () => {
  it('rewrites an installed optional-peer load into a literal require', () => {
    const source = "const { DatadogNodeServerProvider } = requireOptionalPeer('@datadog/openfeature-node-server')"

    const result = optionalPeerLoader.call({ cacheable: () => {}, context: __dirname }, source)

    assert.ok(result.includes("require('@datadog/openfeature-node-server')"), 'should use a literal require')
    assert.ok(!result.includes('requireOptionalPeer('), 'should drop the opaque call')
  })
})
