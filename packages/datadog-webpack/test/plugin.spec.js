'use strict'

const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const optionalPeerLoader = require('../src/optional-peer-loader')

/**
 * @param {string} source
 * @param {object} options
 * @param {Function} [resolveModule]
 * @returns {Promise<string>}
 */
function runLoader (source, options, resolveModule = async () => { throw new Error('unexpected resolve') }) {
  return loader.call({
    addDependency: () => {},
    cacheable: () => {},
    getOptions: () => options,
    getResolve: () => resolveModule,
    resourcePath: '/app/node_modules/mypackage/index.js',
  }, source)
}

/**
 * @param {object} [plugin]
 * @returns {Function}
 */
function captureAfterResolve (plugin = new DatadogWebpackPlugin()) {
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
  })

  describe('optional peer bundling', () => {
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

    it('marks instrumented packages as side-effectful and records their format', () => {
      const Plugin = proxyquire('../index', {
        '../datadog-instrumentations/src/helpers/bundler-modules': new Set(['express']),
      })
      const createData = {
        resource: require.resolve('express'),
        settings: {},
      }

      captureAfterResolve(new Plugin())({ createData, request: 'express' })

      assert.strictEqual(createData.settings.sideEffects, true)
      assert.strictEqual(createData.loaders[0].options.format, 'commonjs')
    })

    it('does not wrap the original module loaded by an IITM wrapper', () => {
      const createData = {
        resource: `${require.resolve('express')}${loader.ORIGINAL_QUERY}`,
        request: 'express',
        settings: {},
      }

      captureAfterResolve()({ createData })

      assert.strictEqual(createData.loaders, undefined)
    })
  })
})

describe('loader', () => {
  it('wraps CommonJS through IITM', async () => {
    const source = "'use strict'\nmodule.exports = { foo: 'bar' }"
    const options = {
      format: 'commonjs',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.2.3',
    }

    const result = await runLoader(source, options)

    assert.match(result, /registerCommonJS/)
    assert.match(result, /"version":"1\.2\.3"/)
    assert.doesNotMatch(result, /dd-trace:bundler:load/)
  })

  it('wraps ESM and maps the original module separately', async () => {
    const options = {
      format: 'module',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }

    const result = await runLoader('export const value = 42', options)

    assert.match(result, /registerWithData/)
    assert.match(result, /index\.js\?__dd_iitm_original__/)
    assert.doesNotMatch(result, /\.\/__iitm_module_0__\.js/)
  })

  it('resolves and loads ESM re-exports through webpack', async () => {
    const nestedPath = require.resolve('../../datadog-esbuild/test/resources/export-method.mjs')
    const options = {
      format: 'module',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }
    const result = await runLoader(
      "export * from './export-method.mjs'",
      options,
      async (context, specifier) => {
        assert.strictEqual(context, '/app/node_modules/mypackage')
        assert.strictEqual(specifier, pathToFileURL('/app/node_modules/mypackage/export-method.mjs').href)
        return nestedPath
      }
    )

    assert.match(result, /exportMethod/)
    assert.doesNotMatch(result, /\.\/__iitm_module_0__\.js/)
  })

  it('resolves builtin re-exports without calling webpack', async () => {
    const options = {
      format: 'module',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }
    const result = await runLoader("export * from 'node:fs'", options)

    assert.match(result, /\$readFile/)
    assert.match(result, /registerWithData/)
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
