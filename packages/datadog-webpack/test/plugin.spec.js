'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')

const DC_MODULE_REQUIRE = `require(${JSON.stringify(require.resolve('dc-polyfill').replaceAll('\\', '/'))})`

/**
 * @param {string} projectDir
 * @param {string} name
 * @param {string} version
 */
function writePackage (projectDir, name, version) {
  const packageDir = path.join(projectDir, 'node_modules', ...name.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name, version }))
  return packageDir
}

/**
 * @param {string} resourcePath
 * @param {object} options
 * @param {string} source
 * @param {object} [inputSourceMap]
 */
function runLoader (resourcePath, options, source, inputSourceMap) {
  let callbackArgs
  const context = {
    cacheable: () => {},
    getOptions: () => options,
    resourcePath,
    callback: (...args) => { callbackArgs = args },
  }

  const returned = loader.call(context, source, inputSourceMap)

  assert.equal(returned, undefined, 'loader should pass its result through this.callback')
  assert.ok(callbackArgs, 'loader should call this.callback')
  const [error, code, map] = callbackArgs
  assert.equal(error, null)

  return { code, map }
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

  describe('afterResolve', () => {
    let projectDir
    let afterResolve

    before(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-webpack-plugin-'))
      writePackage(projectDir, '@langchain/langgraph', '1.4.19')
      writePackage(projectDir, 'express', '4.22.1')
      writePackage(projectDir, 'left-pad', '1.3.0')

      const compiler = {
        options: {},
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: {
            tap: (name, fn) => {
              fn({ hooks: { afterResolve: { tap: (name, hook) => { afterResolve = hook } } } })
            },
          },
        },
      }
      new DatadogWebpackPlugin().apply(compiler)
    })

    after(() => {
      fs.rmSync(projectDir, { recursive: true, force: true })
    })

    /**
     * @param {string} request
     * @param {string} modulePath
     * @param {object[]} [loaders]
     */
    function resolve (request, modulePath, loaders) {
      const resolveData = {
        request,
        createData: { resource: path.join(projectDir, 'node_modules', modulePath), loaders },
      }
      afterResolve(resolveData)
      return resolveData.createData.loaders
    }

    it('marks rewrite targets without export hooks as rewrite-only', () => {
      const loaders = resolve('./pregel/index.cjs', '@langchain/langgraph/dist/pregel/index.cjs')

      assert.equal(loaders?.length, 1)
      assert.equal(loaders[0].loader, require.resolve('../src/loader'))
      assert.deepEqual(loaders[0].options, {
        pkg: '@langchain/langgraph',
        version: '1.4.19',
        path: '@langchain/langgraph/dist/pregel/index.cjs',
        rewriteOnly: true,
      })
    })

    it('does not mark modules with export hooks as rewrite-only', () => {
      const loaders = resolve('./lib/express', 'express/lib/express.js')

      assert.equal(loaders?.length, 1)
      assert.deepEqual(loaders[0].options, {
        pkg: 'express',
        version: '4.22.1',
        path: 'express/lib/express.js',
        rewriteOnly: false,
      })
    })

    it('runs before existing loaders so it receives the original source', () => {
      const transpiler = { loader: 'babel-loader', options: {} }
      const loaders = resolve(
        './pregel/index.cjs',
        '@langchain/langgraph/dist/pregel/index.cjs',
        [transpiler]
      )

      // Webpack runs loaders right-to-left, so the last entry runs first.
      assert.equal(loaders?.length, 2)
      assert.equal(loaders[0], transpiler)
      assert.equal(loaders[1].loader, require.resolve('../src/loader'))
    })

    it('skips modules that are neither rewrite targets nor modules of interest', () => {
      assert.equal(resolve('left-pad', 'left-pad/index.js'), undefined)
    })
  })
})

describe('loader', () => {
  it('appends dc-polyfill channel publish to module source', () => {
    const source = "'use strict'\nmodule.exports = { foo: 'bar' }"
    const options = { pkg: 'mypackage', version: '1.2.3', path: 'mypackage' }

    const { code } = runLoader('/app/node_modules/mypackage/index.js', options, source)

    // Switch to `assert.match(code, new RegExp(`^${RegExp.escape(source)}`), ...)` once the minimum supported
    // Node.js version is 24. Until then, `RegExp.escape` is unavailable and hand-escaping every regex metacharacter
    // in `source` would be more error-prone than this `startsWith` check.
    // eslint-disable-next-line eslint-rules/eslint-prefer-assert-match
    assert.ok(code.startsWith(source), 'result should start with original source')
    assert.ok(code.includes(DC_MODULE_REQUIRE), 'result should require the resolved dc-polyfill')
    assert.ok(code.includes("'dd-trace:bundler:load'"), 'result should use the bundler channel')
    assert.ok(code.includes("version: '1.2.3'"), 'result should contain the version')
    assert.ok(code.includes("package: 'mypackage'"), 'result should contain the package name')
    assert.ok(code.includes("path: 'mypackage'"), 'result should contain the path')
    assert.ok(code.includes('module.exports = __dd_payload.module'), 'result should update module.exports')
  })

  it('uses __dd_ prefix to avoid name collisions', () => {
    const options = { pkg: 'pkg', version: '1.0.0', path: 'pkg' }

    const { code } = runLoader('/app/node_modules/pkg/index.js', options, 'module.exports = {}')

    assert.ok(code.includes('__dd_dc'), 'should use __dd_dc variable')
    assert.ok(code.includes('__dd_ch'), 'should use __dd_ch variable')
    assert.ok(code.includes('__dd_mod'), 'should use __dd_mod variable')
    assert.ok(code.includes('__dd_payload'), 'should use __dd_payload variable')
  })

  it('passes the input source map through', () => {
    const options = { pkg: 'pkg', version: '1.0.0', path: 'pkg' }
    const inputSourceMap = { version: 3, sources: ['index.ts'], names: [], mappings: 'AAAA' }

    const { map } = runLoader('/app/node_modules/pkg/index.js', options, 'module.exports = {}', inputSourceMap)

    assert.equal(map, inputSourceMap)
  })

  describe('orchestrion rewrite targets', () => {
    let projectDir
    let langgraphDir
    let mcpDir

    before(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-webpack-loader-'))
      langgraphDir = writePackage(projectDir, '@langchain/langgraph', '1.4.19')
      mcpDir = writePackage(projectDir, '@modelcontextprotocol/sdk', '1.27.1')
    })

    after(() => {
      fs.rmSync(projectDir, { recursive: true, force: true })
    })

    describe('pure orchestrion target', () => {
      const pkg = '@langchain/langgraph'
      const modulePath = 'dist/pregel/index.cjs'
      const options = { pkg, version: '1.4.19', path: `${pkg}/${modulePath}`, rewriteOnly: true }

      it('rewrites the target and appends the activation publish', () => {
        const source = 'class Pregel { async stream () { return [] } }\nmodule.exports = { Pregel }\n'

        const { code, map } = runLoader(path.join(langgraphDir, modulePath), options, source)

        assert.ok(code.includes('orchestrion:@langchain/langgraph:Pregel_stream'), 'code should be rewritten')
        assert.ok(code.includes(DC_MODULE_REQUIRE), 'code should require the resolved dc-polyfill')
        assert.ok(code.includes("'dd-trace:bundler:load'"), 'code should use the bundler channel')
        assert.ok(
          code.includes(JSON.stringify({ activate: true, package: pkg, version: '1.4.19', path: options.path })),
          'code should publish the activation payload'
        )
        assert.ok(code.includes('if (__dd_ch.hasSubscribers)'), 'activation should be gated on subscribers')
        assert.ok(!code.includes('__dd_payload'), 'code should not publish the module exports')
        assertObjectContains(JSON.parse(map), { version: 3, sources: [`${pkg}/${modulePath}`] })
      })

      it('publishes the target file path when the target was requested by its package name', () => {
        const source = 'class Pregel { async stream () { return [] } }\nmodule.exports = { Pregel }\n'

        const { code } = runLoader(path.join(langgraphDir, modulePath), { ...options, path: pkg }, source)

        const payload = { activate: true, package: pkg, version: '1.4.19', path: `${pkg}/${modulePath}` }
        assert.ok(code.includes(JSON.stringify(payload)), 'activation path should identify the target file')
      })

      it('returns the source untouched when the target does not match the function query', () => {
        const source = 'module.exports = { notPregel: true }\n'
        const inputSourceMap = { version: 3, sources: ['index.ts'], names: [], mappings: 'AAAA' }

        const { code, map } = runLoader(path.join(langgraphDir, modulePath), options, source, inputSourceMap)

        assert.equal(code, source)
        assert.equal(map, inputSourceMap)
      })

      it('returns the source untouched when the installed version is unsupported', () => {
        const unsupportedDir = writePackage(path.join(projectDir, 'unsupported'), pkg, '0.0.1')
        const source = 'class Pregel { async stream () { return [] } }\nmodule.exports = { Pregel }\n'

        const { code } = runLoader(path.join(unsupportedDir, modulePath), options, source)

        assert.equal(code, source)
      })
    })

    describe('target with export hooks', () => {
      const pkg = '@modelcontextprotocol/sdk'
      const modulePath = 'dist/cjs/client/index.js'
      const options = { pkg, version: '1.27.1', path: `${pkg}/${modulePath}`, rewriteOnly: false }

      it('rewrites the target, appends the module publish and returns the rewritten source map', () => {
        const source = 'class Client { async callTool () { return 1 } }\nmodule.exports = { Client }\n'

        const { code, map } = runLoader(path.join(mcpDir, modulePath), options, source)

        assert.ok(code.includes('orchestrion:@modelcontextprotocol/sdk:Client_callTool'), 'code should be rewritten')
        assert.ok(code.includes('module.exports = __dd_payload.module'), 'code should publish the module exports')
        assert.ok(!code.includes('"activate":true'), 'code should not publish an activation')
        assertObjectContains(JSON.parse(map), { version: 3, sources: [`${pkg}/${modulePath}`] })
      })

      it('appends the module publish when the target does not match the function query', () => {
        const source = 'module.exports = { notClient: true }\n'

        const { code } = runLoader(path.join(mcpDir, modulePath), options, source)

        assert.equal(code.slice(0, source.length), source, 'result should start with original source')
        assert.ok(!code.includes('orchestrion:'), 'result should not be rewritten')
        assert.ok(code.includes('module.exports = __dd_payload.module'), 'result should publish the module exports')
      })
    })
  })
})
