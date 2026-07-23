'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const optionalPeerLoader = require('../src/optional-peer-loader')

/**
 * @typedef {(
 *   data: { context?: string, contextInfo?: { issuerLayer?: string }, request?: string },
 *   callback: (error?: Error | null, result?: string | boolean) => void
 * ) => void} WebpackExternal
 */

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

    /**
     * @param {string | object | WebpackExternal | Array<string | object | WebpackExternal>} [externals]
     * @returns {Array<string | object | WebpackExternal>}
     */
    function applyToExternals (externals) {
      const compiler = {
        options: {
          optimization: {},
          externals,
        },
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: { tap: () => {} },
        },
      }
      new DatadogWebpackPlugin().apply(compiler)
      return compiler.options.externals
    }

    /**
     * @param {WebpackExternal} external
     * @param {string} context
     * @param {string | undefined} request
     * @param {string} [issuerLayer]
     * @returns {string | boolean | undefined}
     */
    function resolveExternal (external, context, request, issuerLayer) {
      let resolved
      const callback = (error, result) => {
        if (error) throw error
        resolved = result
      }
      if (external.length === 3) external(context, request, callback)
      else external({ context, contextInfo: { issuerLayer }, request }, callback)
      return resolved
    }

    it('bundles API fallbacks imported by dd-trace', () => {
      const externals = applyToExternals({ '@opentelemetry/api': 'module @opentelemetry/api' })
      const holderDirectory = path.dirname(require.resolve('../../dd-trace/src/opentelemetry/api'))
      const vendorDirectory = path.dirname(require.resolve('../../../vendor/dist/@opentelemetry/core'))

      assert.strictEqual(resolveExternal(externals[0], holderDirectory, '@opentelemetry/api'), undefined)
      assert.strictEqual(resolveExternal(externals[0], vendorDirectory, '@opentelemetry/api'), undefined)
      assert.strictEqual(resolveExternal(externals[0], holderDirectory, '@opentelemetry/api-logs'), undefined)
      assert.strictEqual(resolveExternal(externals[0], holderDirectory, '@opentelemetry/api/experimental'), undefined)
    })

    it('normalizes Windows separators when identifying the fallback graph', () => {
      const externals = applyToExternals('@opentelemetry/api')
      const holderDirectory = path.dirname(require.resolve('../../dd-trace/src/opentelemetry/api'))
        .replaceAll('/', '\\')

      assert.strictEqual(resolveExternal(externals[0], holderDirectory, '@opentelemetry/api'), undefined)
    })

    it('preserves normal external behavior outside dd-trace', () => {
      const userExternals = ['pg', { '@opentelemetry/api': 'module @opentelemetry/api' }]
      const externals = applyToExternals(userExternals)

      assert.strictEqual(resolveExternal(externals[0], '/app', 'pg'), 'pg')
      assert.strictEqual(
        resolveExternal(externals[1], '/app', '@opentelemetry/api'),
        'module @opentelemetry/api'
      )
    })

    it('preserves RegExp, function, and layered object externals', () => {
      const modern = ({ request }, callback) => {
        callback(null, request === 'modern' || request === '@opentelemetry/api' ? `commonjs ${request}` : undefined)
      }
      const legacy = (context, request, callback) => {
        callback(null, request === 'legacy' || request === '@opentelemetry/api' ? `commonjs ${request}` : undefined)
      }
      const fallbackDirectory = path.dirname(require.resolve('../../dd-trace/src/opentelemetry/api'))
      const externals = applyToExternals([
        /^regex$/,
        modern,
        legacy,
        {
          pg: 'commonjs pg',
          byLayer: {
            worker: {
              '@opentelemetry/api': 'commonjs @opentelemetry/api',
              worker: 'commonjs worker',
            },
          },
        },
      ])

      assert.strictEqual(resolveExternal(externals[0], '/app', 'regex'), 'regex')
      assert.strictEqual(resolveExternal(externals[1], '/app', 'modern'), 'commonjs modern')
      assert.strictEqual(resolveExternal(externals[2], '/app', 'legacy'), 'commonjs legacy')
      assert.strictEqual(resolveExternal(externals[1], fallbackDirectory, '@opentelemetry/api'), undefined)
      assert.strictEqual(resolveExternal(externals[2], fallbackDirectory, '@opentelemetry/api'), undefined)
      assert.strictEqual(resolveExternal(externals[3], '/app', 'pg', 'worker'), 'commonjs pg')
      assert.strictEqual(resolveExternal(externals[3], '/app', 'worker', 'worker'), 'commonjs worker')
      assert.strictEqual(
        resolveExternal(externals[3], '/app', '@opentelemetry/api', 'worker'),
        'commonjs @opentelemetry/api'
      )
    })

    it('preserves every supported static external shape', () => {
      const externals = applyToExternals([
        'pg',
        /^regex$/,
        { byLayer: layer => ({ [layer]: `commonjs ${layer}` }) },
        { byLayer: { default: { fallback: 'commonjs fallback' } } },
        { pg: 'commonjs pg', byLayer: { worker: null } },
        { pg: 'commonjs pg', byLayer: { worker: 'commonjs worker' } },
        { pg: 'commonjs pg', byLayer: { worker: [] } },
        [['nested']],
        true,
      ])

      assert.strictEqual(resolveExternal(externals[0], '/app', 'missing'), undefined)
      assert.strictEqual(resolveExternal(externals[1], '/app', undefined), undefined)
      assert.strictEqual(resolveExternal(externals[1], '/app', 'missing'), undefined)
      assert.strictEqual(resolveExternal(externals[2], '/app', 'worker', 'worker'), 'commonjs worker')
      assert.strictEqual(resolveExternal(externals[3], '/app', 'fallback'), 'commonjs fallback')
      assert.strictEqual(resolveExternal(externals[4], '/app', 'pg', 'worker'), 'commonjs pg')
      assert.strictEqual(resolveExternal(externals[4], '/app', 'missing', 'worker'), undefined)
      assert.strictEqual(resolveExternal(externals[5], '/app', 'pg', 'worker'), 'commonjs pg')
      assert.strictEqual(resolveExternal(externals[6], '/app', 'pg', 'worker'), 'commonjs pg')
      assert.strictEqual(resolveExternal(externals[7][0][0], '/app', 'nested'), 'nested')
      assert.strictEqual(resolveExternal(externals[8], '/app', 'anything'), undefined)
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

    it('applies the optional-peer loader to require-provider', () => {
      const createData = { resource: require.resolve('../../dd-trace/src/openfeature/require-provider') }

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
