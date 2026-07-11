'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')

const ddPlugin = require('../index')

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * @param {Record<string, string | Record<string, string>>} manifest
 * @returns {string}
 */
function createManifestDirectory (manifest) {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-esbuild-otel-'))
  temporaryDirectories.push(workingDirectory)
  fs.writeFileSync(path.join(workingDirectory, 'package.json'), JSON.stringify(manifest))
  return workingDirectory
}

/**
 * @param {string} workingDirectory
 * @param {string} name
 * @param {string} version
 */
function installPackage (workingDirectory, name, version) {
  const packageDirectory = path.join(workingDirectory, 'node_modules', ...name.split('/'))
  fs.mkdirSync(packageDirectory, { recursive: true })
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name,
    version,
    main: 'index.js',
  }))
  fs.writeFileSync(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n')
}

function captureOptionalPeerOnLoad () {
  let onLoad
  ddPlugin.setup({
    initialOptions: {},
    onResolve () {},
    onLoad (options, callback) {
      if (options.filter.source.includes('require-provider')) onLoad = callback
    },
  })
  return onLoad
}

/**
 * @param {import('esbuild').BuildOptions} [initialOptions]
 * @returns {{
 *   external: string[] | undefined,
 *   resolve: (args: import('esbuild').OnResolveArgs) => object | undefined,
 *   resolveAny: (args: import('esbuild').OnResolveArgs) => object | undefined
 * }}
 */
function setupOtelApiResolution (initialOptions = {}) {
  const handlers = []
  ddPlugin.setup({
    initialOptions,
    onResolve (options, callback) {
      handlers.push({ options, callback })
    },
    onLoad () {},
  })
  const { callback: resolve } = handlers.find(({ options }) => {
    return options.filter.test('@opentelemetry/api') && !options.filter.test('express')
  })
  const { callback: resolveAny } = handlers.find(({ options }) => options.filter.test('express'))
  return { external: initialOptions.external, resolve, resolveAny }
}

describe('datadog-esbuild plugin', () => {
  describe('OpenTelemetry API externalization', () => {
    it('externalizes application imports of both installed API packages', () => {
      const { resolve } = setupOtelApiResolution()

      assert.deepStrictEqual(resolve({
        path: '@opentelemetry/api',
        importer: '/app/index.js',
      }), {
        path: '@opentelemetry/api',
        external: true,
      })
      assert.deepStrictEqual(resolve({
        path: '@opentelemetry/api-logs',
        importer: '/app/index.js',
      }), {
        path: '@opentelemetry/api-logs',
        external: true,
      })
    })

    it('keeps the externals supplied by the build', () => {
      const { external, resolve } = setupOtelApiResolution({ external: ['pg'] })

      assert.deepStrictEqual(external, ['pg'])
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: '/app/index.js' }).external, true)
    })

    it('moves an exact user API external into the importer-aware resolver', () => {
      const workingDirectory = createManifestDirectory({
        name: 'app',
        dependencies: { '@opentelemetry/api': '^1.9.0' },
      })
      installPackage(workingDirectory, '@opentelemetry/api', '1.9.0')
      const { external, resolve } = setupOtelApiResolution({
        absWorkingDir: workingDirectory,
        external: ['@opentelemetry/api'],
      })

      assert.deepStrictEqual(external, [])
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: '/app/index.js' }).external, true)
      assert.strictEqual(
        resolve({ path: '@opentelemetry/api/experimental', importer: '/app/index.js' }).external,
        true
      )
    })

    it('moves wildcard API externals without changing their unrelated matches', () => {
      const workingDirectory = createManifestDirectory({ name: 'app', dependencies: {} })
      const { external, resolve, resolveAny } = setupOtelApiResolution({
        absWorkingDir: workingDirectory,
        external: ['@opentelemetry/*'],
      })
      const holderImporter = require.resolve('../../dd-trace/src/opentelemetry/api')

      assert.deepStrictEqual(external, [])
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: holderImporter }), undefined)
      assert.strictEqual(resolveAny({ path: '@opentelemetry/api', importer: holderImporter }), undefined)
      assert.deepStrictEqual(resolveAny({
        path: '@opentelemetry/core',
        importer: '/app/index.js',
      }), {
        path: '@opentelemetry/core',
        external: true,
      })
    })

    it('bundles the holder fallback even when the application package is external', () => {
      const { resolve, resolveAny } = setupOtelApiResolution()
      const importer = require.resolve('../../dd-trace/src/opentelemetry/api')

      assert.strictEqual(resolve({
        path: '@opentelemetry/api',
        importer,
      }), undefined)
      const result = resolveAny({
        importer,
        kind: 'require-call',
        namespace: 'file',
        path: '@opentelemetry/api',
        resolveDir: path.dirname(importer),
      })
      assert.strictEqual(result.pluginData.applicationOwned, false)
      assert.strictEqual(
        result.pluginData.moduleBaseDir,
        path.resolve(path.dirname(require.resolve('@opentelemetry/api')), '../..')
      )
    })

    it('marks resolved application API modules as application-owned', () => {
      const workingDirectory = createManifestDirectory({
        name: 'app',
        dependencies: { '@opentelemetry/api': '^1.9.0' },
      })
      installPackage(workingDirectory, '@opentelemetry/api', '1.9.0')
      const { resolveAny } = setupOtelApiResolution({ absWorkingDir: workingDirectory })

      const result = resolveAny({
        importer: path.join(workingDirectory, 'app.js'),
        kind: 'require-call',
        namespace: 'file',
        path: '@opentelemetry/api',
        resolveDir: workingDirectory,
      })

      assert.strictEqual(result.pluginData.applicationOwned, true)
      assert.strictEqual(
        result.pluginData.moduleBaseDir,
        fs.realpathSync(path.join(workingDirectory, 'node_modules', '@opentelemetry', 'api'))
      )
    })

    it('bundles a package the application does not depend on so the bundle stays self-contained', () => {
      const workingDirectory = createManifestDirectory({ name: 'app', dependencies: {} })
      installPackage(workingDirectory, '@opentelemetry/api', '1.9.0')

      const { external, resolve } = setupOtelApiResolution({
        absWorkingDir: workingDirectory,
        external: ['@opentelemetry/api'],
      })

      assert.deepStrictEqual(external, [])
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: '/app/index.js' }), undefined)
      assert.strictEqual(
        resolve({ path: '@opentelemetry/api/experimental', importer: '/app/index.js' }),
        undefined
      )
      assert.strictEqual(resolve({ path: '@opentelemetry/api-logs', importer: '/app/index.js' }), undefined)
    })

    it('externalizes only the package the application declares', () => {
      const workingDirectory = createManifestDirectory({
        name: 'app',
        dependencies: { '@opentelemetry/api': '^1.9.0' },
      })
      installPackage(workingDirectory, '@opentelemetry/api', '1.9.0')
      installPackage(workingDirectory, '@opentelemetry/api-logs', '0.203.0')

      const { resolve } = setupOtelApiResolution({ absWorkingDir: workingDirectory })

      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: '/app/index.js' }).external, true)
      assert.strictEqual(resolve({ path: '@opentelemetry/api-logs', importer: '/app/index.js' }), undefined)
    })
  })

  describe('optional peer bundling', () => {
    it('rewrites the installed peer load in require-provider into a literal require', () => {
      const onLoad = captureOptionalPeerOnLoad()
      const providerPath = require.resolve('../../dd-trace/src/openfeature/require-provider')

      const result = onLoad({ path: providerPath })

      assert.ok(result.contents.includes("require('@datadog/openfeature-node-server')"), 'should inline the peer')
      assert.ok(
        !result.contents.includes("requireOptionalPeer('@datadog/openfeature-node-server')"),
        'should drop the opaque load'
      )
    })

    it('ignores files that match the filter but are not an optional-peer file', () => {
      const onLoad = captureOptionalPeerOnLoad()

      assert.strictEqual(onLoad({ path: '/somewhere/else/require-provider.js' }), undefined)
    })
  })
})
