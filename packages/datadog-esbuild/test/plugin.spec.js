'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules, createRequire, SourceMap } = require('node:module')
const os = require('node:os')
const path = require('node:path')

const { after, before, describe, it } = require('mocha')

const ddPlugin = require('../index')

const FIXTURES = path.join(__dirname, '../../datadog-instrumentations/test/helpers/bundler-esm-exports')

const builtins = new Set(builtinModules)

/**
 * Stands in for esbuild's `build.resolve()`: Node.js resolution, with builtins kept external.
 *
 * @param {object[]} calls
 */
function createResolve (calls) {
  /**
   * @param {string} specifier
   * @param {{ importer: string, resolveDir: string, kind: string, pluginData?: object }} options
   */
  return async function resolve (specifier, options) {
    calls.push({ specifier, ...options })
    if (specifier.startsWith('node:') || builtins.has(specifier)) {
      return { path: specifier, external: true, namespace: 'file', errors: [] }
    }
    try {
      const resolved = createRequire(options.importer).resolve(specifier)
      return { path: resolved, external: false, namespace: 'file', errors: [] }
    } catch (error) {
      return { path: '', errors: [{ text: error.message }] }
    }
  }
}

/**
 * Sets the plugin up on a fake build and returns its callbacks.
 *
 * @param {object} [initialOptions]
 * @param {Function} [resolve] Replaces the fake `build.resolve()`.
 */
function setupPlugin (initialOptions = {}, resolve) {
  let onLoad
  let onResolve
  const resolveCalls = []
  ddPlugin.setup({
    initialOptions,
    resolve: resolve ?? createResolve(resolveCalls),
    onEnd () {},
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onResolve (options, callback) {
      onResolve = callback
    },
    /**
     * @param {object} options
     * @param {Function} callback
     */
    onLoad (options, callback) {
      onLoad = callback
    },
  })
  return { onLoad, onResolve, resolveCalls }
}

/**
 * @param {object} [initialOptions]
 */
function captureOnLoad (initialOptions) {
  return setupPlugin(initialOptions).onLoad
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

/** @param {object} [initialOptions] */
function captureOnResolve (initialOptions = {}) {
  let onResolve
  ddPlugin.setup({
    initialOptions,
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

/**
 * @param {string} modulePath
 * @returns {{ path: string, pluginData: object }}
 */
function wrapperArgs (modulePath) {
  return {
    path: `${modulePath}._dd_esbuild_intercepted`,
    pluginData: {
      internal: false,
      isESM: true,
      pkg: 'fixture',
      pkgOfInterest: true,
      raw: 'fixture',
    },
  }
}

/**
 * Resolves an import of a loaded wrapper through the plugin.
 *
 * @param {Function} onResolve
 * @param {string} wrapperPath
 * @param {string} specifier
 */
function resolveWrapperImport (onResolve, wrapperPath, specifier) {
  return onResolve({
    path: specifier,
    importer: wrapperPath,
    resolveDir: path.dirname(wrapperPath),
    kind: 'import-statement',
    namespace: 'file',
  })
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

  describe('Orchestrion rewrite targets', () => {
    const pkg = '@langchain/langgraph'
    const version = '1.4.19'
    const dcModuleLiteral = JSON.stringify(require.resolve('dc-polyfill').replaceAll('\\', '/'))
    let projectDir

    before(() => {
      projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-esbuild-plugin-')))
      for (const [name, packageVersion] of [
        [pkg, version],
        ['express', '4.22.1'],
        ['left-pad', '1.3.0'],
        ['ai', '6.0.0'],
        ['@modelcontextprotocol/sdk', '1.27.1'],
      ]) {
        const packageDir = path.join(projectDir, 'node_modules', name)
        fs.mkdirSync(packageDir, { recursive: true })
        fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
          name,
          version: packageVersion,
          ...(name === pkg && { type: 'module', main: 'dist/pregel/index.cjs' }),
        }))
        fs.writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {}\n')
      }
      fs.mkdirSync(path.join(projectDir, 'node_modules', pkg, 'dist/pregel'), { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'node_modules', pkg, 'dist/pregel/index.cjs'), 'module.exports = {}\n')
      fs.mkdirSync(path.join(projectDir, 'node_modules/express/lib'), { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'node_modules/express/lib/express.js'), 'module.exports = {}\n')
    })

    after(() => {
      fs.rmSync(projectDir, { recursive: true, force: true })
    })

    /**
     * @param {string} request
     * @param {object} [initialOptions]
     */
    function resolve (request, initialOptions) {
      const onResolve = captureOnResolve(initialOptions)
      return onResolve({
        path: request,
        resolveDir: projectDir,
        kind: request.endsWith('.js') ? 'import-statement' : 'require-call',
        namespace: 'file',
        importer: path.join(projectDir, 'app.js'),
      })
    }

    for (const [extension, isESM] of [['cjs', false], ['js', true]]) {
      describe(isESM ? 'ESM (.js)' : 'CommonJS', () => {
        const modulePath = `dist/pregel/index.${extension}`
        const source = 'class Pregel { async stream () { return [] } }\n' +
          (isESM ? 'export { Pregel }\n' : 'module.exports = { Pregel }\n')
        let resourcePath

        before(() => {
          resourcePath = path.join(projectDir, 'node_modules', pkg, modulePath)
          fs.writeFileSync(resourcePath, source)
        })

        it('resolves rewrite-only targets without the IITM suffix', () => {
          const request = `${pkg}/${modulePath}`
          const result = resolve(request, { format: isESM ? 'esm' : 'cjs' })

          assert.equal(result.path, resourcePath)
          assert.deepEqual(result.pluginData, {
            version,
            pkg,
            path: modulePath,
            full: resourcePath,
            raw: request,
            pkgOfInterest: true,
            rewriteOnly: true,
            kind: isESM ? 'import-statement' : 'require-call',
            internal: false,
            isESM,
          })
        })

        it('rewrites pure targets and publishes activation with the target file path', async () => {
          const resolved = resolve(`${pkg}/${modulePath}`)
          // Even a package entrypoint must activate the specific target file, not the bare package name.
          resolved.pluginData.raw = pkg
          const onLoad = captureOnLoad()
          const result = await onLoad(resolved)

          assert.match(result.contents, /orchestrion:@langchain\/langgraph:Pregel_stream/)
          assert.ok(result.contents.includes(dcModuleLiteral), 'dc-polyfill must be an absolute literal')
          assert.ok(result.contents.includes(JSON.stringify({
            activate: true,
            package: pkg,
            version,
            path: `${pkg}/${modulePath}`,
          })))
          assert.match(result.contents, /if \(__dd_ch.hasSubscribers\) __dd_ch.publish/)
          assert.doesNotMatch(result.contents, /payload.module|import-in-the-middle|register\(/)
          assert.equal(result.loader, 'js')
          assert.equal(result.resolveDir, path.dirname(resourcePath))
          if (isESM) {
            assert.ok(result.contents.includes(`import __dd_dc from ${dcModuleLiteral}`))
            assert.doesNotMatch(result.contents, /require\(/)
          } else {
            assert.ok(result.contents.includes(`require(${dcModuleLiteral}).channel('dd-trace:bundler:load')`))
          }

          const inlineMap = result.contents.match(/sourceMappingURL=data:application\/json;base64,([^\n]+)/)
          assert.ok(inlineMap, 'rewritten source map should be inlined')
          const map = JSON.parse(Buffer.from(inlineMap[1], 'base64').toString())
          assert.equal(map.version, 3)
          assert.deepEqual(map.sources, [path.basename(resourcePath)])
          assert.ok(map.mappings, 'rewritten map should retain position mappings')
          assert.deepEqual(map.sourcesContent, [source])
        })

        it('does not publish exports or activation when the function query does not match', async () => {
          const unmatchedSource = isESM ? 'export const notPregel = true\n' : 'module.exports = { notPregel: true }\n'
          fs.writeFileSync(resourcePath, unmatchedSource)
          try {
            const onLoad = captureOnLoad()
            const result = await onLoad(resolve(`${pkg}/${modulePath}`))

            assert.equal(result.contents, unmatchedSource)
            assert.doesNotMatch(result.contents, /dd-trace:bundler:load/)
          } finally {
            fs.writeFileSync(resourcePath, source)
          }
        })

        it('does not publish exports or activation for unsupported versions', async () => {
          const unsupportedDir = path.join(projectDir, 'unsupported', extension, 'node_modules', pkg)
          const unsupportedPath = path.join(unsupportedDir, modulePath)
          fs.mkdirSync(path.dirname(unsupportedPath), { recursive: true })
          fs.writeFileSync(path.join(unsupportedDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.1' }))
          fs.writeFileSync(unsupportedPath, source)
          const { pluginData } = resolve(`${pkg}/${modulePath}`)

          const onLoad = captureOnLoad()
          const result = await onLoad({
            path: unsupportedPath,
            pluginData: { ...pluginData, version: '0.0.1' },
          })

          assert.equal(result.contents, source)
        })

        if (isESM) {
          it('avoids colliding with existing bindings in the activation import', async () => {
            fs.writeFileSync(resourcePath, `const __dd_dc = true\nconst __dd_dc1 = true\n${source}`)
            try {
              const onLoad = captureOnLoad()
              const result = await onLoad(resolve(`${pkg}/${modulePath}`))

              assert.ok(result.contents.includes(`import __dd_dc2 from ${dcModuleLiteral}`))
              assert.match(result.contents, /const __dd_ch = __dd_dc2.channel/)
            } finally {
              fs.writeFileSync(resourcePath, source)
            }
          })
        }
      })
    }

    it('resolves rewrite targets requested by package name from application code', () => {
      const result = resolve(pkg)

      assert.equal(result.pluginData.rewriteOnly, true)
      assert.equal(result.pluginData.path, 'dist/pregel/index.cjs')
    })

    it('keeps CommonJS modules of interest on the export-hook path', async () => {
      const result = resolve('express/lib/express.js')

      assert.equal(result.pluginData.rewriteOnly, false)
      const onLoad = captureOnLoad()
      const loaded = await onLoad(result)
      assert.match(loaded.contents, /module.exports = payload.module/)
      assert.match(loaded.contents, /package: 'express'/)
      assert.match(loaded.contents, /path: 'express\/lib\/express.js'/)
      assert.doesNotMatch(loaded.contents, /orchestrion:|"activate":true/)
    })

    it('ignores unrelated packages and local scoped aliases', () => {
      assert.equal(resolve('left-pad'), undefined)
      assert.equal(resolve('@/local'), undefined)
    })

    it('rewrites targets with neither activation nor export hooks without publishing', async () => {
      const resourcePath = path.join(projectDir, 'node_modules/ai/dist/index.js')
      fs.mkdirSync(path.dirname(resourcePath), { recursive: true })
      fs.writeFileSync(resourcePath, 'function getTracer () { return {} }\nmodule.exports = { getTracer }\n')
      const resolved = resolve('ai/dist/index.js')
      const onLoad = captureOnLoad()
      const result = await onLoad(resolved)

      assert.equal(resolved.pluginData.rewriteOnly, true)
      assert.match(result.contents, /orchestrion:ai:getTracer/)
      assert.doesNotMatch(result.contents, /dd-trace:bundler:load|payload.module/)
    })

    for (const matches of [true, false]) {
      it(`preserves export hooks for rewrite targets ${matches ? 'matching' : 'not matching'} the query`, async () => {
        const resourcePath = path.join(projectDir, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js')
        const source = matches
          ? 'class Client { async callTool () { return 1 } }\nmodule.exports = { Client }\n'
          : 'module.exports = { notClient: true }\n'
        fs.mkdirSync(path.dirname(resourcePath), { recursive: true })
        fs.writeFileSync(resourcePath, source)
        const resolved = resolve('@modelcontextprotocol/sdk/dist/cjs/client/index.js')
        const onLoad = captureOnLoad()
        const result = await onLoad(resolved)

        assert.equal(resolved.pluginData.rewriteOnly, false)
        assert.match(result.contents, /module.exports = payload.module/)
        assert.doesNotMatch(result.contents, /"activate":true/)
        if (matches) {
          assert.match(result.contents, /orchestrion:@modelcontextprotocol\/sdk:Client_callTool/)
          const inlineMap = result.contents.match(/sourceMappingURL=data:application\/json;base64,([^\n]+)/)
          const map = new SourceMap(JSON.parse(Buffer.from(inlineMap[1], 'base64').toString()))
          const lines = result.contents.split('\n')
          const returnLine = lines.findIndex(line => line.includes('return 1'))
          const original = map.findEntry(returnLine, lines[returnLine].indexOf('1'))
          assert.equal(original.originalLine, 0, 'map should account for the export-hook wrapper')
        } else {
          assert.doesNotMatch(result.contents, /orchestrion:/)
        }
      })
    }

    it('routes ESM rewrite targets with export hooks through the IITM wrapper', async () => {
      const esmDir = path.join(projectDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm')
      const resourcePath = path.join(esmDir, 'server/mcp.js')
      fs.mkdirSync(path.dirname(resourcePath), { recursive: true })
      fs.writeFileSync(path.join(esmDir, 'package.json'), JSON.stringify({ type: 'module' }))
      fs.writeFileSync(resourcePath, 'export class McpServer { async executeToolHandler () { return 1 } }\n')
      const { onLoad, onResolve } = setupPlugin({ format: 'esm' })
      const request = '@modelcontextprotocol/sdk/dist/esm/server/mcp.js'

      const wrapper = resolve(request, { format: 'esm' })
      assert.equal(wrapper.path, `${resourcePath}._dd_esbuild_intercepted`)
      assert.equal(wrapper.pluginData.isESM, true)
      assert.equal(wrapper.pluginData.rewriteOnly, false)

      const wrapperPath = wrapper.path
      const wrapperResult = await onLoad(wrapper)
      assert.ok(wrapperResult.contents.includes('import * as namespace from "./__iitm_module_0__.js"'))
      assert.doesNotMatch(wrapperResult.contents, /orchestrion:/)

      const real = resolveWrapperImport(onResolve, wrapperPath, './__iitm_module_0__.js')
      assert.equal(real.path, resourcePath)
      assert.equal(real.pluginData.isESM, true)

      const loadReal = captureOnLoad()
      const realResult = await loadReal(real)
      assert.match(realResult.contents, /orchestrion:@modelcontextprotocol\/sdk:McpServer_executeToolHandler/)
      assert.doesNotMatch(realResult.contents, /dd-trace:bundler:load|import-in-the-middle/)
    })
  })

  describe('ESM wrappers', () => {
    let projectDir

    before(() => {
      projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-esbuild-wrapper-')))
    })

    after(() => {
      fs.rmSync(projectDir, { recursive: true, force: true })
    })

    /**
     * Writes the modules into a new directory and returns the path of the first one.
     *
     * @param {Record<string, string>} files
     */
    function writeModules (files) {
      const dir = fs.mkdtempSync(path.join(projectDir, 'case-'))
      for (const [name, source] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), source)
      }
      return path.join(dir, Object.keys(files)[0])
    }

    it('uses the build directory to resolve imports in built-in module wrappers', async () => {
      const absWorkingDir = path.dirname(process.cwd())
      const result = await loadBuiltinWrapper({ absWorkingDir })

      assert.strictEqual(result.resolveDir, absWorkingDir)
    })

    it('defaults the build directory to the current working directory', async () => {
      const result = await loadBuiltinWrapper()

      assert.strictEqual(result.resolveDir, process.cwd())
    })

    it('keeps the built-in module of a built-in module wrapper external', async () => {
      const { onLoad, onResolve } = setupPlugin()
      const wrapperPath = '/_dd_esm_internal_/dns/promises._dd_esbuild_intercepted'

      const result = await onLoad({
        path: wrapperPath,
        pluginData: { internal: true, isESM: true, pkgOfInterest: true, raw: 'dns/promises' },
      })

      assert.ok(result.contents.includes('register("node:dns/promises", __binder, "dns/promises", "builtin")'))
      assert.deepStrictEqual(resolveWrapperImport(onResolve, wrapperPath, './__iitm_module_0__.js'), {
        path: 'node:dns/promises',
        external: true,
      })
    })

    it('uses the module directory to resolve imports in package wrappers', async () => {
      const onLoad = captureOnLoad()
      const modulePath = path.join(FIXTURES, 'export-method.mjs')

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

    it('resolves the wrapper placeholders and watches the analyzed modules', async () => {
      const { onLoad, onResolve } = setupPlugin()
      const modulePath = writeModules({
        'index.mjs': "export * from './left.mjs'\nexport * from './right.mjs'\n",
        'left.mjs': "export * from './shared.mjs'\n",
        'right.mjs': "export * from './shared.mjs'\n",
        'shared.mjs': 'export const shared = true\n',
      })
      const dir = path.dirname(modulePath)
      const args = wrapperArgs(modulePath)
      const wrapperPath = args.path

      const result = await onLoad(args)

      assert.deepStrictEqual(result.watchFiles, ['index.mjs', 'left.mjs', 'shared.mjs', 'right.mjs'].map(name => {
        return path.join(dir, name)
      }))
      assert.deepStrictEqual(resolveWrapperImport(onResolve, wrapperPath, './__iitm_runtime__.js'), {
        path: fs.realpathSync(require.resolve('import-in-the-middle/lib/register.js')),
      })
      const original = resolveWrapperImport(onResolve, wrapperPath, './__iitm_module_0__.js')
      assert.deepStrictEqual(original, { path: modulePath })
      assert.deepStrictEqual(resolveWrapperImport(onResolve, wrapperPath, './__iitm_module_1__.js'), {
        path: path.join(dir, 'shared.mjs'),
      })
      assert.strictEqual(resolveWrapperImport(onResolve, wrapperPath, './unknown.js'), undefined)
    })

    it('resolves re-exports through build.resolve without instrumenting them', async () => {
      const { onLoad, onResolve, resolveCalls } = setupPlugin()
      const modulePath = writeModules({
        'index.mjs': "export * from './cjs.js'\n",
        'cjs.js': "module.exports = require('./required.js')\n",
        'required.js': 'exports.fromRequire = true\n',
      })
      const dir = path.dirname(modulePath)

      await onLoad(wrapperArgs(modulePath))

      const pluginData = { ddAnalysisResolve: true }
      assert.deepStrictEqual(resolveCalls, [
        {
          specifier: './cjs.js',
          importer: modulePath,
          kind: 'import-statement',
          namespace: 'file',
          pluginData,
          resolveDir: dir,
        },
        {
          specifier: './required.js',
          importer: path.join(dir, 'cjs.js'),
          kind: 'require-call',
          namespace: 'file',
          pluginData,
          resolveDir: dir,
        },
      ])
      assert.strictEqual(onResolve({
        path: 'express',
        importer: modulePath,
        resolveDir: dir,
        kind: 'import-statement',
        namespace: 'file',
        pluginData: resolveCalls[0].pluginData,
      }), undefined)
    })

    it('analyzes re-exports the build keeps external and keeps their imports external', async () => {
      const modulePath = writeModules({
        'index.mjs': "export * from './left.mjs'\nexport * from './right.mjs'\n",
        'left.mjs': "export * from 'external-package'\n",
        'right.mjs': "export * from 'external-package'\n",
      })
      const packageDir = path.join(path.dirname(modulePath), 'node_modules', 'external-package')
      fs.mkdirSync(packageDir, { recursive: true })
      fs.writeFileSync(path.join(packageDir, 'package.json'), '{ "main": "index.mjs" }')
      fs.writeFileSync(path.join(packageDir, 'index.mjs'), 'export const fromPackage = true\n')
      const resolveExternal = async (/** @type {string} */ specifier, /** @type {{ importer: string }} */ options) => {
        if (specifier === 'external-package') return { path: specifier, external: true, errors: [] }
        return { path: createRequire(options.importer).resolve(specifier), namespace: 'file', errors: [] }
      }
      const { onLoad, onResolve } = setupPlugin({}, resolveExternal)
      const args = wrapperArgs(modulePath)
      const wrapperPath = args.path

      const result = await onLoad(args)

      assert.match(result.contents, /as "fromPackage"/)
      assert.deepStrictEqual(resolveWrapperImport(onResolve, wrapperPath, './__iitm_module_1__.js'), {
        path: 'external-package',
        external: true,
      })
    })

    it('rejects re-exports the build cannot resolve', async () => {
      const onLoad = captureOnLoad()
      const modulePath = writeModules({ 'index.mjs': "export * from './missing.mjs'\n" })

      await assert.rejects(onLoad(wrapperArgs(modulePath)), {
        message: new RegExp(`^Unable to resolve "./missing.mjs" from "${modulePath}": Cannot find module`),
      })
    })

    it('rejects re-exports resolved into another namespace', async () => {
      const { onLoad } = setupPlugin({}, async () => ({ path: 'virtual', namespace: 'virtual', errors: [] }))
      const modulePath = writeModules({ 'index.mjs': "export * from 'virtual-module'\n" })

      await assert.rejects(onLoad(wrapperArgs(modulePath)), {
        message: `Unsupported re-export "virtual-module" from "${modulePath}" in namespace "virtual"`,
      })
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
        onEnd () {},
        onResolve () {},
        onLoad () {},
      })
      assert.equal(initialOptions.banner.js.includes('DD_GIT_COMMIT_SHA'), false)
      assert.equal(initialOptions.banner.js.includes('DD_GIT_REPOSITORY_URL'), false)
    })
  })
})
