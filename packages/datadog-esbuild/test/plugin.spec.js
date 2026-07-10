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
 * @returns {string[] | undefined}
 */
function setupExternal (initialOptions = {}) {
  ddPlugin.setup({ initialOptions, onResolve () {}, onLoad () {} })
  return initialOptions.external
}

describe('datadog-esbuild plugin', () => {
  describe('OpenTelemetry API externalization', () => {
    // The repo's own package.json declares both packages, so a build run from the repo root
    // externalizes both (they are the application's declared copies).
    it('marks both OpenTelemetry API packages external so the bundle shares the application copy', () => {
      const external = setupExternal()

      assert.ok(external.includes('@opentelemetry/api'), 'should externalize @opentelemetry/api')
      assert.ok(external.includes('@opentelemetry/api-logs'), 'should externalize @opentelemetry/api-logs')
    })

    it('keeps the externals supplied by the build', () => {
      const external = setupExternal({ external: ['pg'] })

      assert.ok(external.includes('pg'), 'should preserve user externals')
      assert.ok(external.includes('@opentelemetry/api'), 'should externalize @opentelemetry/api')
      assert.ok(external.includes('@opentelemetry/api-logs'), 'should externalize @opentelemetry/api-logs')
    })

    it('does not duplicate an OpenTelemetry API external supplied by the build', () => {
      const external = setupExternal({ external: ['@opentelemetry/api'] })

      assert.strictEqual(external.filter(name => name === '@opentelemetry/api').length, 1)
    })

    it('bundles a package the application does not depend on so the bundle stays self-contained', () => {
      const workingDirectory = createManifestDirectory({ name: 'app', dependencies: {} })

      const external = setupExternal({ absWorkingDir: workingDirectory }) ?? []

      assert.ok(!external.includes('@opentelemetry/api'), 'should bundle @opentelemetry/api')
      assert.ok(!external.includes('@opentelemetry/api-logs'), 'should bundle @opentelemetry/api-logs')
    })

    it('externalizes only the package the application declares', () => {
      const workingDirectory = createManifestDirectory({
        name: 'app',
        dependencies: { '@opentelemetry/api': '^1.9.0' },
      })

      const external = setupExternal({ absWorkingDir: workingDirectory }) ?? []

      assert.ok(external.includes('@opentelemetry/api'), 'should externalize the declared copy')
      assert.ok(!external.includes('@opentelemetry/api-logs'), 'should bundle the undeclared copy')
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
