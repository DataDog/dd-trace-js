'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ddPlugin = require('../index')

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
  describe('OpenTelemetry API fallback bundling', () => {
    it('keeps normal application external behavior', () => {
      const { external, resolve, resolveAny } = setupOtelApiResolution({
        external: ['pg', '@opentelemetry/api', '@opentelemetry/api-logs'],
      })

      assert.deepStrictEqual(external, ['pg'])
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
      assert.strictEqual(resolveAny({
        path: 'dc-polyfill',
        importer: '/app/index.js',
        kind: 'require-call',
        namespace: 'file',
        resolveDir: __dirname,
      }), undefined)
    })

    it('bundles the holder fallback despite exact user externals', () => {
      const { resolve } = setupOtelApiResolution({ external: ['@opentelemetry/api'] })
      const importer = require.resolve('../../dd-trace/src/opentelemetry/api')
      const vendoredImporter = require.resolve('../../../vendor/dist/@opentelemetry/core')

      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer }), undefined)
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: vendoredImporter }), undefined)
    })

    it('bundles the holder fallback despite wildcard user externals', () => {
      const { external, resolve, resolveAny } = setupOtelApiResolution({
        external: ['@opentelemetry/*'],
      })
      const importer = require.resolve('../../dd-trace/src/opentelemetry/api')

      assert.deepStrictEqual(external, [])
      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer }), undefined)
      assert.deepStrictEqual(resolveAny({
        path: '@opentelemetry/core',
        importer: '/app/index.js',
      }), {
        path: '@opentelemetry/core',
        external: true,
      })
    })

    it('normalizes Windows separators when identifying the holder', () => {
      const { resolve } = setupOtelApiResolution({ external: ['@opentelemetry/api'] })
      const importer = require.resolve('../../dd-trace/src/opentelemetry/api').replaceAll('/', '\\')

      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer }), undefined)
    })

    it('leaves application imports bundled without user externals', () => {
      const { resolve } = setupOtelApiResolution()

      assert.strictEqual(resolve({ path: '@opentelemetry/api', importer: '/app/index.js' }), undefined)
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
