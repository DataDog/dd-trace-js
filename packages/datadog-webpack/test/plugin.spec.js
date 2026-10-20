'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const createBundlerBanner = require('../../datadog-instrumentations/src/helpers/bundler-banner')
const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const log = require('../src/log')

/**
 * @param {{ target: string|string[], optimization: { minimize: boolean },
 *   externalsPresets?: { node: boolean }, output?: { module: boolean } }} options
 * @param {{ chunks?: Array<{ canBeInitial: () => boolean, files: Set<string> }>,
 *   assets?: Record<string, { source: () => string, map: () => object }> }} [fixtures]
 */
function createCompilerHarness (options, { chunks = [], assets = {} } = {}) {
  let environmentHook
  let compilationHook
  let processAssetsHook
  const updates = []
  const outputAssets = new Map(Object.entries(assets))

  class ConcatSource {
    /** @param {...(string|{ source: () => string, map: () => object })} parts */
    constructor (...parts) {
      this.parts = parts
    }

    source () {
      return this.parts.map(part => typeof part === 'string' ? part : part.source()).join('')
    }

    map () {
      return /** @type {{ map: () => object }} */ (this.parts.at(-1)).map()
    }
  }

  const compiler = {
    options,
    webpack: { sources: { ConcatSource } },
    hooks: {
      environment: { tap: (_name, hook) => { environmentHook = hook } },
      thisCompilation: { tap: (_name, hook) => { compilationHook = hook } },
      normalModuleFactory: { tap: () => {} },
    },
  }

  return {
    compiler,
    updates,
    outputAssets,
    runEnvironment () {
      environmentHook()
    },
    runCompilation () {
      const compilation = {
        chunks,
        hooks: {
          processAssets: { tap: (_options, hook) => { processAssetsHook = hook } },
        },
        updateAsset (filename, update) {
          updates.push(filename)
          outputAssets.set(filename, update(outputAssets.get(filename)))
        },
      }

      compilationHook(compilation)
      processAssetsHook()
    },
  }
}

/**
 * @param {string} content
 * @param {object} map
 */
function createSource (content, map) {
  return {
    source: () => content,
    map: () => map,
  }
}

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
      const harness = createCompilerHarness({ optimization: { minimize: true }, target: 'node' })

      plugin.apply(harness.compiler)
      assert.throws(
        () => harness.runEnvironment(),
        /optimization\.minimize is not compatible/
      )
    })

    it('does not throw when minimize is not enabled', () => {
      const plugin = new DatadogWebpackPlugin()
      const harness = createCompilerHarness({ optimization: { minimize: false }, target: 'node' })

      plugin.apply(harness.compiler)
      harness.runEnvironment()
    })

    it('marks initial JavaScript assets, including .cjs, once each and preserves source maps', () => {
      const plugin = new DatadogWebpackPlugin()
      const map = { version: 3, sources: ['entry.js'], mappings: 'AAAA' }
      const harness = createCompilerHarness(
        { optimization: { minimize: false }, target: 'node' },
        {
          chunks: [
            { canBeInitial: () => true, files: new Set(['main.js', 'shared.mjs', 'legacy.cjs', 'main.js.map']) },
            { canBeInitial: () => true, files: new Set(['shared.mjs']) },
            { canBeInitial: () => false, files: new Set(['async.js']) },
          ],
          assets: {
            'main.js': createSource('main()', map),
            'shared.mjs': createSource('export {}', map),
            'legacy.cjs': createSource('module.exports = {}', map),
            'main.js.map': createSource('{}', map),
            'async.js': createSource('async()', map),
          },
        }
      )

      plugin.apply(harness.compiler)
      harness.runCompilation()

      const banner = createBundlerBanner('webpack')
      for (const filename of ['main.js', 'shared.mjs', 'legacy.cjs']) {
        const asset = harness.outputAssets.get(filename)
        assert.ok(asset, `expected emitted asset ${filename}`)
        assert.ok(asset.source().includes(banner), `expected ${filename} to be marked`)
        assert.equal(asset.map(), map, 'ConcatSource should retain the original source map')
      }
      assert.deepEqual(harness.updates.sort(), ['legacy.cjs', 'main.js', 'shared.mjs'])
      assert.equal(harness.outputAssets.get('async.js')?.source(), 'async()')
      assert.equal(harness.outputAssets.get('main.js.map')?.source(), '{}')
    })

    it('adds the bundler banner without git metadata and preserves source mapping', () => {
      const originalDirectory = process.cwd()
      const noGitDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-webpack-no-git-'))
      const map = { version: 3, sources: ['entry.mjs'], mappings: 'AAAA' }
      const source = createSource('export const value = 1', map)
      const jsMap = { version: 3, sources: ['entry.js'], mappings: 'AAAA' }
      const jsSource = createSource('module.exports = 1', jsMap)

      try {
        process.chdir(noGitDirectory)
        const plugin = new DatadogWebpackPlugin()
        const harness = createCompilerHarness(
          { optimization: { minimize: false }, target: 'node' },
          {
            chunks: [{ canBeInitial: () => true, files: new Set(['entry.js', 'entry.mjs']) }],
            assets: { 'entry.js': jsSource, 'entry.mjs': source },
          }
        )

        plugin.apply(harness.compiler)
        harness.runCompilation()

        const banner = createBundlerBanner('webpack')
        for (const filename of ['entry.js', 'entry.mjs']) {
          const output = harness.outputAssets.get(filename)
          assert.ok(output, `expected emitted asset ${filename}`)
          assert.equal(output.source().slice(0, banner.length), banner)
          assert.doesNotMatch(output.source(), /DD_GIT_/)
        }
        const esmAsset = harness.outputAssets.get('entry.mjs')
        const commonJsAsset = harness.outputAssets.get('entry.js')
        assert.ok(esmAsset)
        assert.ok(commonJsAsset)
        assert.equal(esmAsset.map(), map)
        assert.equal(commonJsAsset.map(), jsMap)
        assert.deepEqual(harness.updates, ['entry.js', 'entry.mjs'])
      } finally {
        process.chdir(originalDirectory)
        fs.rmSync(noGitDirectory, { recursive: true, force: true })
      }
    })

    it('warns for non-Node targets and disabled Node externals without failing', () => {
      const plugin = new DatadogWebpackPlugin()
      const harness = createCompilerHarness({
        optimization: { minimize: false },
        target: 'web',
        externalsPresets: { node: false },
      })
      const warnings = []
      const originalWarn = log.warn
      log.warn = (...args) => warnings.push(args)

      try {
        plugin.apply(harness.compiler)
        harness.runEnvironment()
      } finally {
        log.warn = originalWarn
      }

      assert.equal(warnings.length, 2, 'expected warnings for target and disabled Node externals')
      assert.match(warnings[0][0], /target %s/)
      assert.match(warnings[1][0], /externalsPresets\.node is false/)
    })

    it('recognizes versioned, asynchronous, and multi-target Node configurations', () => {
      const originalWarn = log.warn
      const warnings = []
      log.warn = (...args) => warnings.push(args)
      try {
        for (const target of ['node', 'node18', 'node18.12', 'async-node', 'async-node18.12', ['node', 'es2022']]) {
          const harness = createCompilerHarness({ target, optimization: { minimize: false } })
          new DatadogWebpackPlugin().apply(harness.compiler)
          harness.runEnvironment()
        }
        assert.deepStrictEqual(warnings, [])
      } finally {
        log.warn = originalWarn
      }
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

      /**
       * @param {typeof DatadogWebpackPlugin} Plugin
       */
      function applyAndProcessAssets (Plugin) {
        const harness = createCompilerHarness(
          { optimization: { minimize: false }, target: 'node' },
          {
            chunks: [
              { canBeInitial: () => false, files: new Set(['lazy.js']) },
              { canBeInitial: () => true, files: new Set(['bundle.js', 'notes.txt']) },
            ],
            assets: {
              'lazy.js': createSource('lazy()', null),
              'bundle.js': createSource('module.exports = 1\n', null),
              'notes.txt': createSource('notes', null),
            },
          }
        )

        new Plugin().apply(harness.compiler)
        harness.runCompilation()

        assert.deepEqual(harness.updates, ['bundle.js'])
        return harness.outputAssets.get('bundle.js')
      }

      it('prefixes initial js assets with git metadata', () => {
        const content = applyAndProcessAssets(DatadogWebpackPlugin).source()

        assert.match(content, /DD_GIT_COMMIT_SHA|DD_GIT_REPOSITORY_URL/)
        assert.ok(content.includes(createBundlerBanner('webpack')), 'expected the bundle marker')
        assert.match(content, /module\.exports = 1\n$/)
      })

      it('only adds the bundle marker when DD_BUNDLER_INJECT_GIT_METADATA=false', () => {
        process.env.DD_BUNDLER_INJECT_GIT_METADATA = 'false'
        delete require.cache[pluginPath]
        const content = applyAndProcessAssets(require('../index')).source()

        assert.doesNotMatch(content, /DD_GIT_/)
        assert.equal(content, createBundlerBanner('webpack') + 'module.exports = 1\n')
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
