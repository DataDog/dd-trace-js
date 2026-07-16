'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const withDatadogConfig = require('../../../next')

/**
 * @param {string} code
 * @returns {NodeJS.ErrnoException}
 */
function createModuleError (code) {
  return Object.assign(new Error(code), { code })
}

/**
 * @param {(specifier: string, packageJsonPath: string) => string|Error|undefined} resolveOverride
 * @returns {typeof withDatadogConfig}
 */
function loadWithResolve (resolveOverride) {
  /**
   * @param {string} packageJsonPath
   * @returns {{ resolve: (specifier: string) => string }}
   */
  function createRequireStub (packageJsonPath) {
    const packageRequire = createRequire(packageJsonPath)

    /**
     * @param {string} specifier
     * @returns {string}
     */
    function resolve (specifier) {
      const override = resolveOverride(specifier, packageJsonPath)
      if (override instanceof Error) throw override
      return override ?? packageRequire.resolve(specifier)
    }

    return { resolve }
  }

  return proxyquire('../src/next', {
    'node:module': {
      createRequire: createRequireStub,
    },
  })
}

describe('Next.js config helper', () => {
  it('externalizes dd-trace without changing other Next.js config', () => {
    const original = {
      poweredByHeader: false,
      serverExternalPackages: ['pg'],
    }

    assert.deepStrictEqual(withDatadogConfig(original), {
      poweredByHeader: false,
      serverExternalPackages: ['pg', 'dd-trace'],
    })
    assert.deepStrictEqual(original.serverExternalPackages, ['pg'])
    assert.deepStrictEqual(withDatadogConfig(), {
      serverExternalPackages: ['dd-trace'],
    })
  })

  it('uses default project and tracing roots', () => {
    const parentRoot = path.dirname(process.cwd())
    const withDefaultProjectRoot = withDatadogConfig({
      output: 'standalone',
      outputFileTracingRoot: parentRoot,
    })
    const withDefaultTracingRoot = withDatadogConfig({
      output: 'standalone',
    }, {
      projectRoot: parentRoot,
    })

    assert.ok(withDefaultProjectRoot.outputFileTracingIncludes['/*'].length > 0)
    assert.ok(withDefaultTracingRoot.outputFileTracingIncludes['/*'].length > 0)
  })

  it('includes the tracer runtime dependency closure in standalone output', () => {
    const existingGlobalInclude = 'assets/**/*'
    const config = withDatadogConfig({
      output: 'standalone',
      outputFileTracingRoot: path.dirname(process.cwd()),
      outputFileTracingIncludes: {
        '/*': [existingGlobalInclude],
        '/api/*': ['api-assets/**/*'],
      },
      serverExternalPackages: ['dd-trace', 'pg'],
    }, {
      projectRoot: process.cwd(),
    })

    assert.deepStrictEqual(config.serverExternalPackages, ['dd-trace', 'pg'])
    assert.deepStrictEqual(config.outputFileTracingIncludes['/api/*'], ['api-assets/**/*'])

    const globalIncludes = config.outputFileTracingIncludes['/*']
    assert.strictEqual(globalIncludes[0], existingGlobalInclude)
    assert.strictEqual(new Set(globalIncludes).size, globalIncludes.length)
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/dc-polyfill/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/import-in-the-middle/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/opentracing/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/cjs-module-lexer/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@datadog/libdatadog/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@datadog/native-appsec/**/*')))
    assert.ok(globalIncludes.some(
      include => include.endsWith('/node_modules/@datadog/native-iast-taint-tracking/**/*')
    ))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@datadog/native-metrics/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@datadog/pprof/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@datadog/wasm-js-rewriter/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@opentelemetry/api/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@opentelemetry/api-logs/**/*')))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/oxc-parser/**/*')))
    assert.ok(globalIncludes.some(
      include => include.endsWith('/node_modules/@datadog/openfeature-node-server/**/*')
    ))
    assert.ok(globalIncludes.some(include => include.endsWith('/node_modules/@openfeature/server-sdk/**/*')))
  })

  it('rejects dependency paths outside outputFileTracingRoot', () => {
    const projectRoot = path.join(process.cwd(), 'packages', 'dd-trace')

    assert.throws(() => withDatadogConfig({
      output: 'standalone',
      outputFileTracingRoot: projectRoot,
    }, {
      projectRoot,
    }), {
      message: /outputFileTracingRoot/,
    })
  })

  it('rejects a resolved dependency without a package manifest', () => {
    const existsSync = fs.existsSync
    let resolvingDependency = false

    /**
     * @param {string} filePath
     * @returns {boolean}
     */
    function existsSyncWithoutDependencyManifest (filePath) {
      if (filePath.includes(`${path.sep}dc-polyfill${path.sep}`)) {
        resolvingDependency = true
      }
      return resolvingDependency ? false : existsSync(filePath)
    }

    const configHelper = proxyquire('../src/next', {
      'node:fs': {
        existsSync: existsSyncWithoutDependencyManifest,
      },
    })

    assert.throws(() => configHelper({
      output: 'standalone',
      outputFileTracingRoot: path.dirname(process.cwd()),
    }), {
      message: /Could not resolve the package manifest/,
    })
  })

  it('propagates errors resolving optional dependencies', () => {
    /**
     * @param {string} specifier
     * @returns {Error|undefined}
     */
    function failOptionalDependency (specifier) {
      if (specifier === '@datadog/libdatadog/package.json') {
        return createModuleError('EACCES')
      }
    }

    const configHelper = loadWithResolve(failOptionalDependency)

    assert.throws(() => configHelper({
      output: 'standalone',
      outputFileTracingRoot: path.dirname(process.cwd()),
    }), {
      code: 'EACCES',
    })
  })

  it('skips an optional dependency whose required peer is absent', () => {
    /**
     * @param {string} specifier
     * @returns {Error|undefined}
     */
    function omitOpenFeaturePeer (specifier) {
      if (specifier === '@openfeature/server-sdk/package.json') {
        return createModuleError('MODULE_NOT_FOUND')
      }
    }

    const configHelper = loadWithResolve(omitOpenFeaturePeer)
    const config = configHelper({
      output: 'standalone',
      outputFileTracingRoot: path.dirname(process.cwd()),
    })

    assert.ok(config.outputFileTracingIncludes['/*'].every(
      include => !include.endsWith('/node_modules/@datadog/openfeature-node-server/**/*')
    ))
  })
})
