'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const wasmLoader = require('../src/wasm-loader')

describe('DatadogWebpackPlugin', () => {
  describe('apply', () => {
    it('throws when minimize is enabled', () => {
      const plugin = new DatadogWebpackPlugin()
      const { callbacks, compiler } = createCompiler(true)

      plugin.apply(compiler)
      assert.throws(
        () => callbacks.environment(),
        /optimization\.minimize is not compatible/
      )
    })

    it('does not throw when minimize is not enabled', () => {
      const plugin = new DatadogWebpackPlugin()
      const { callbacks, compiler } = createCompiler(false)

      plugin.apply(compiler)
      assert.equal(callbacks.normalModuleFactoryName, 'DatadogWebpackPlugin')
    })

    it('adds the WASM loader only to JavaScript modules', () => {
      const plugin = new DatadogWebpackPlugin()
      const { callbacks, compiler } = createCompiler(false)
      const packageRoot = '/app/node_modules/@datadog/libdatadog-wasm'

      plugin.apply(compiler)

      const configuredLoader = { loader: '/configured-loader.js' }
      const js = { loaders: [configuredLoader], resource: `${packageRoot}/index.js` }
      callbacks.afterResolve({ createData: js })
      assert.deepStrictEqual(js.loaders, [
        configuredLoader,
        { loader: require.resolve('../src/wasm-loader') },
      ])

      const json = { resource: `${packageRoot}/package.json` }
      callbacks.afterResolve({ createData: json })
      assert.strictEqual(json.loaders, undefined)
    })
  })
})

/**
 * @param {boolean} minimize
 */
function createCompiler (minimize) {
  const callbacks = {}
  const compiler = {
    options: {
      optimization: { minimize },
    },
    hooks: {
      environment: {
        /**
         * @param {string} name
         * @param {Function} handler
         */
        tap (name, handler) {
          callbacks.environment = handler
        },
      },
      thisCompilation: { tap: () => {} },
      normalModuleFactory: {
        /**
         * @param {string} name
         * @param {Function} handler
         */
        tap (name, handler) {
          callbacks.normalModuleFactoryName = name
          handler({
            hooks: {
              afterResolve: {
                /**
                 * @param {string} name
                 * @param {Function} handler
                 */
                tap (name, handler) {
                  callbacks.afterResolve = handler
                },
              },
            },
          })
        },
      },
    },
  }
  return { callbacks, compiler }
}

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

describe('WASM loader', () => {
  it('leaves releases without external WASM assets unchanged', () => {
    const source = 'module.exports = Buffer.from("inline WASM")'
    const result = wasmLoader.call({
      cacheable: () => {},
      resourcePath: '/fixture.js',
    }, source)

    assert.strictEqual(result, source)
  })

  it('inlines marked assets and watches the compressed file', () => {
    const fixture = createWasmFixture()
    const dependencies = []
    let cacheable = false
    try {
      const result = wasmLoader.call({
        addDependency: dependency => dependencies.push(dependency),
        cacheable: () => { cacheable = true },
        resourcePath: fixture.modulePath,
      }, fixture.source)

      assert.strictEqual(cacheable, true)
      assert.deepStrictEqual(dependencies, [fixture.assetPath])
      assert.doesNotMatch(result, /@datadog\/wasm-asset|\.wasm\.br/)
      assert.match(result, /Buffer\.from\("Zml4dHVyZSBXQVNN", 'base64'\)/)
    } finally {
      fs.rmSync(fixture.directory, { force: true, recursive: true })
    }
  })

  it('fails when a marked asset is missing', () => {
    const fixture = createWasmFixture()
    try {
      fs.rmSync(fixture.assetPath)
      assert.throws(() => wasmLoader.call({
        addDependency: () => {},
        cacheable: () => {},
        resourcePath: fixture.modulePath,
      }, fixture.source), /fixture_bg\.wasm\.br/)
    } finally {
      fs.rmSync(fixture.directory, { force: true, recursive: true })
    }
  })

  it('fails when the marked loader shape changes', () => {
    const fixture = createWasmFixture('const bytes = /* @datadog/wasm-asset */ loadWasm()')
    try {
      assert.throws(() => wasmLoader.call({
        addDependency: () => {},
        cacheable: () => {},
        resourcePath: fixture.modulePath,
      }, fixture.source), /Unsupported .* asset loader/)
    } finally {
      fs.rmSync(fixture.directory, { force: true, recursive: true })
    }
  })
})

/**
 * @param {string} [source]
 */
function createWasmFixture (source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webpack-wasm-'))
  const modulePath = path.join(directory, 'fixture.js')
  const assetPath = path.join(directory, 'fixture_bg.wasm.br')
  const dirnameExpression = '${' + '__dirname}'
  const loaderSource = source ?? 'const bytes = /* @datadog/wasm-asset */ ' +
    `require('node:fs').readFileSync(\`${dirnameExpression}/fixture_bg.wasm.br\`)`
  fs.writeFileSync(assetPath, 'fixture WASM')
  fs.writeFileSync(modulePath, loaderSource)
  return { assetPath, directory, modulePath, source: loaderSource }
}
