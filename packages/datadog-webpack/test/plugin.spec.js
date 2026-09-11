'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')

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
 * @param {typeof DatadogWebpackPlugin} [Plugin]
 * @returns {Function}
 */
function captureAfterResolve (Plugin = DatadogWebpackPlugin) {
  let afterResolve
  const plugin = new Plugin()
  plugin.apply({
    options: { optimization: {} },
    hooks: {
      environment: { tap: () => {} },
      thisCompilation: { tap: () => {} },
      normalModuleFactory: {
        /**
         * @param {string} name
         * @param {Function} hook
         */
        tap (name, hook) {
          hook({
            hooks: {
              afterResolve: {
                /**
                 * @param {string} hookName
                 * @param {Function} callback
                 */
                tap (hookName, callback) { afterResolve = callback },
              },
            },
          })
        },
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

    it('marks instrumented packages as side-effectful and records their format', () => {
      const createData = {
        resource: require.resolve('graphql/execution/execute'),
        settings: {},
      }

      const afterResolve = captureAfterResolve()
      afterResolve({ createData, request: 'graphql/execution/execute' })

      assert.strictEqual(createData.settings.sideEffects, true)
      assert.strictEqual(createData.loaders[0].options.format, 'module')
      assert.strictEqual(createData.loaders[0].options.moduleName, 'graphql/execution/execute.mjs')
      assert.strictEqual(createData.loaders[0].options.specifier, 'graphql')
    })

    it('records top-level package identity', () => {
      const createData = {
        resource: require.resolve('mocha'),
        settings: {},
      }

      const afterResolve = captureAfterResolve()
      afterResolve({ createData, request: 'mocha' })

      assert.strictEqual(createData.loaders[0].options.moduleName, 'mocha')
    })

    it('records linked package identity outside node_modules', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webpack-linked-'))
      try {
        const packageDirectory = path.join(directory, 'packages/mocha')
        const resource = path.join(packageDirectory, 'index.js')
        fs.mkdirSync(packageDirectory, { recursive: true })
        fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
          main: 'index.js',
          name: 'mocha',
          version: '11.0.0',
        }))
        fs.writeFileSync(resource, 'module.exports = {}')
        const createData = { resource, settings: {} }

        const afterResolve = captureAfterResolve()
        afterResolve({ createData, request: 'mocha' })

        assert.strictEqual(createData.loaders[0].options.format, undefined)
        assert.strictEqual(createData.loaders[0].options.moduleName, 'mocha')
        assert.strictEqual(createData.loaders[0].options.version, '11.0.0')
      } finally {
        fs.rmSync(directory, { force: true, recursive: true })
      }
    })

    it('does not wrap the original module loaded by an IITM wrapper', () => {
      const createData = {
        resource: `${require.resolve('graphql/execution/execute')}${loader.ORIGINAL_QUERY}`,
        request: 'graphql/execution/execute',
        settings: {},
      }

      const afterResolve = captureAfterResolve()
      afterResolve({ createData })

      assert.strictEqual(createData.loaders, undefined)
    })

    it('leaves unresolved and incomplete module data unchanged', () => {
      const afterResolve = captureAfterResolve()
      const withoutRequest = { resource: '/app/index.js', settings: {} }
      const withoutPackage = { resource: '/app/index.js', settings: {} }

      afterResolve({ createData: withoutRequest })
      afterResolve({ createData: withoutPackage, request: 'ai' })

      assert.strictEqual(withoutRequest.loaders, undefined)
      assert.strictEqual(withoutPackage.loaders, undefined)
    })
  })
})

describe('loader', () => {
  it('wraps CommonJS through IITM', async () => {
    const source = "'use strict'\nmodule.exports = { foo: 'bar' }"
    const options = {
      format: 'commonjs',
      moduleName: 'mypackage/internal.js',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.2.3',
    }

    const result = await runLoader(source, options)

    assert.match(result, /registerCommonJS/)
    assert.match(result, /"moduleName":"mypackage\/internal\.js"/)
    assert.match(result, /"version":"1\.2\.3"/)
    assert.doesNotMatch(result, /dd-trace:bundler:load/)
  })

  it('wraps ESM and maps the original module separately', async () => {
    const options = {
      format: 'module',
      moduleName: 'mypackage/index.js',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }

    const result = await runLoader('export const value = 42', options)

    assert.match(result, /registerWithData/)
    assert.match(result, /"moduleName":"mypackage\/index\.js"/)
    assert.match(result, /index\.js\?__dd_iitm_original__/)
    assert.doesNotMatch(result, /\.\/__iitm_module_0__\.js/)
  })

  it('detects typeless module formats from source', async () => {
    const options = {
      format: undefined,
      moduleName: 'mypackage',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }

    const [commonjs, esm] = await Promise.all([
      runLoader('module.exports = { value: 42 }', options),
      runLoader('export const value = 42', options),
    ])

    assert.match(commonjs, /registerCommonJS/)
    assert.match(esm, /registerWithData/)
    assert.doesNotMatch(commonjs, /index\.js\?__dd_iitm_original__/)
    assert.match(esm, /index\.js\?__dd_iitm_original__/)
  })

  it('resolves and loads ESM re-exports through webpack', async () => {
    const nestedPath = require.resolve('../../datadog-esbuild/test/resources/export-method.mjs')
    const options = {
      format: 'module',
      specifier: 'mypackage',
      url: 'file:///app/node_modules/mypackage/index.js',
      version: '1.0.0',
    }

    /**
     * @param {string} context
     * @param {string} specifier
     * @returns {Promise<string>}
     */
    async function resolveModule (context, specifier) {
      assert.strictEqual(context, '/app/node_modules/mypackage')
      assert.strictEqual(specifier, pathToFileURL('/app/node_modules/mypackage/export-method.mjs').href)
      return nestedPath
    }

    const result = await runLoader(
      "export * from './export-method.mjs'",
      options,
      resolveModule
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

    assert.match(result, /as readFile/)
    assert.match(result, /registerWithData/)
  })

  it('adapts IITM module I/O and import targets', async () => {
    const nestedPath = require.resolve('../../datadog-esbuild/test/resources/export-method.mjs')
    const nestedUrl = pathToFileURL(nestedPath).href
    const dependencies = []

    /**
     * @param {{ resolve: Function, load: Function }} adapters
     * @returns {Promise<object>}
     */
    async function createWrapperModule ({ resolve, load }) {
      const [fileTarget, builtinTarget] = await Promise.all([
        resolve('nested', {}),
        resolve('builtin-alias', { parentURL: 'file:///app/node_modules/mypackage/index.js' }),
      ])
      const [file, builtin] = await Promise.all([
        load(nestedUrl, {}),
        load('node:fs', { format: 'builtin' }),
      ])

      assert.deepStrictEqual(fileTarget, {
        url: nestedUrl,
        format: undefined,
        watchFiles: [nestedUrl],
      })
      assert.deepStrictEqual(builtinTarget, { url: 'node:fs', format: 'builtin', watchFiles: undefined })
      assert.strictEqual(file.source.toString(), 'export function exportMethod () {}\n')
      assert.strictEqual(file.format, undefined)
      assert.deepStrictEqual(file.watchFiles, [nestedUrl])
      assert.deepStrictEqual(builtin, { format: 'builtin' })

      return {
        code: '"external-target"; "internal-target"',
        imports: [
          {
            specifier: 'external-target',
            target: { url: 'node:fs' },
            external: true,
          },
          {
            specifier: 'internal-target',
            target: { url: nestedUrl },
            external: false,
            kind: 'commonjs',
          },
        ],
        watchFiles: [nestedUrl, 'node:fs'],
      }
    }

    /** @param {string} url */
    function getNodeModuleFormat (url) {
      assert.ok(url.startsWith('file:') || url === 'node:fs')
    }

    const stubbedLoader = proxyquire('../src/loader', {
      'import-in-the-middle/bundler': { createWrapperModule, getNodeModuleFormat },
    })

    /**
     * @param {string} directory
     * @param {string} specifier
     * @returns {Promise<string>}
     */
    async function resolveModule (directory, specifier) {
      assert.strictEqual(directory, '/app/node_modules/mypackage')
      return specifier === 'builtin-alias' ? 'node:fs' : nestedPath
    }

    /** @param {string} file */
    function addDependency (file) {
      dependencies.push(file)
    }

    const result = await stubbedLoader.call({
      addDependency,
      cacheable () {},
      getOptions: () => ({
        format: 'module',
        moduleName: 'mypackage',
        specifier: 'mypackage',
        url: 'file:///app/node_modules/mypackage/index.js',
        version: '1.0.0',
      }),
      getResolve: () => resolveModule,
      resourcePath: '/app/node_modules/mypackage/index.js',
    }, 'export const value = 42')

    assert.match(result, /"node:fs"/)
    assert.ok(result.includes(JSON.stringify(nestedPath)))
    assert.deepStrictEqual(dependencies, [nestedPath])
  })
})
