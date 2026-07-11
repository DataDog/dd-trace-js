'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')
const optionalPeerLoader = require('../src/optional-peer-loader')

/**
 * @typedef {(
 *   data: { context?: string, request?: string },
 *   callback: (error?: Error | null, result?: string | boolean) => void
 * ) => void} WebpackExternal
 */
/**
 * @typedef {(
 *   context: string,
 *   request: string,
 *   callback: (error?: Error | null, result?: string | boolean) => void
 * ) => void} LegacyWebpackExternal
 */

describe('DatadogWebpackPlugin', () => {
  describe('apply', () => {
    const temporaryDirectories = []

    afterEach(() => {
      for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    })

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

    /**
     * @param {string | object | WebpackExternal | Array<string | object | WebpackExternal>} [externals]
     * @param {string} [context]
     * @param {boolean} [outputModule]
     * @returns {Array<string | object | WebpackExternal>}
     */
    function applyToExternals (externals, context, outputModule = false) {
      const compiler = {
        options: {
          optimization: {},
          externals,
          context,
          experiments: { outputModule },
        },
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: { tap: () => {} },
        },
      }
      new DatadogWebpackPlugin().apply(compiler)
      return compiler.options.externals
    }

    /**
     * @param {Record<string, string | Record<string, string>>} manifest
     * @returns {string}
     */
    function createManifestDirectory (manifest) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webpack-otel-'))
      temporaryDirectories.push(directory)
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest))
      return directory
    }

    /**
     * @param {string} directory
     * @param {string} name
     * @param {string} version
     */
    function installPackage (directory, name, version) {
      const packageDirectory = path.join(directory, 'node_modules', ...name.split('/'))
      fs.mkdirSync(packageDirectory, { recursive: true })
      fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
        name,
        version,
        main: 'index.js',
      }))
      fs.writeFileSync(path.join(packageDirectory, 'index.js'), 'module.exports = {}\n')
    }

    /**
     * @param {WebpackExternal} external
     * @param {string} context
     * @param {string} request
     * @returns {string | boolean | undefined}
     */
    function resolveExternal (external, context, request) {
      let resolved
      external({ context, request }, (error, result) => {
        if (error) throw error
        resolved = result
      })
      return resolved
    }

    /**
     * @param {LegacyWebpackExternal} external
     * @param {string} context
     * @param {string} request
     * @returns {string | boolean | undefined}
     */
    function resolveLegacyExternal (external, context, request) {
      let resolved
      external(context, request, (error, result) => {
        if (error) throw error
        resolved = result
      })
      return resolved
    }

    /**
     * @param {unknown} external
     * @param {string} request
     * @returns {boolean}
     */
    function matchesExternal (external, request) {
      if (typeof external === 'string') return external === request
      if (Array.isArray(external)) return external.some(value => matchesExternal(value, request))
      if (external instanceof RegExp) return external.test(request)
      if (typeof external === 'function') {
        return resolveExternal(external, '/app', request) !== undefined
      }
      return external !== null &&
        typeof external === 'object' &&
        Object.hasOwn(external, request)
    }

    /** @type {WebpackExternal} */
    const userExternal = ({ request }, callback) => {
      callback(null, request === '@opentelemetry/api' && 'module @opentelemetry/api')
    }

    it('externalizes both OpenTelemetry API packages as a commonjs require', () => {
      const externals = applyToExternals()

      assert.strictEqual(resolveExternal(externals[0], '/app', '@opentelemetry/api'), 'commonjs @opentelemetry/api')
      assert.strictEqual(
        resolveExternal(externals[0], '/app', '@opentelemetry/api-logs'),
        'commonjs @opentelemetry/api-logs'
      )
      assert.strictEqual(
        resolveExternal(externals[0], '/app', '@opentelemetry/api/experimental'),
        'commonjs @opentelemetry/api/experimental'
      )
      assert.strictEqual(resolveExternal(externals[0], '/app', 'pg'), undefined)
    })

    it('uses createRequire-compatible externals for ESM output', () => {
      const externals = applyToExternals(undefined, undefined, true)

      assert.strictEqual(
        resolveExternal(externals[0], '/app', '@opentelemetry/api'),
        'node-commonjs @opentelemetry/api'
      )
    })

    it('keeps externals supplied as an array', () => {
      const externals = applyToExternals(['pg'])

      assert.deepStrictEqual(externals.slice(1), ['pg'])
    })

    it('keeps a single non-array external', () => {
      const externals = applyToExternals('pg')

      assert.deepStrictEqual(externals.slice(1), ['pg'])
    })

    it('filters nested arrays without changing unrelated externals', () => {
      const externals = applyToExternals([['@opentelemetry/api', 'pg']])

      assert.deepStrictEqual(externals.slice(1), [['pg']])
    })

    it('preserves unrelated regular expression externals', () => {
      const externals = applyToExternals(/^pg$/)

      assert.strictEqual(resolveExternal(externals[1], '/app', 'pg'), 'pg')
      assert.strictEqual(resolveExternal(externals[1], '/app', 'express'), undefined)
    })

    it('preserves unrelated function externals', () => {
      /** @type {WebpackExternal} */
      const userExternal = ({ request }, callback) => callback(null, `commonjs ${request}`)
      const externals = applyToExternals(userExternal)

      assert.strictEqual(resolveExternal(externals[1], '/app', 'pg'), 'commonjs pg')
    })

    it('preserves unrelated legacy function externals', () => {
      /** @type {LegacyWebpackExternal} */
      const userExternal = (context, request, callback) => callback(null, `commonjs ${request}`)
      const externals = applyToExternals(userExternal)

      assert.strictEqual(resolveLegacyExternal(externals[1], '/app', 'pg'), 'commonjs pg')
      assert.strictEqual(resolveLegacyExternal(externals[1], '/app', '@opentelemetry/api'), undefined)
    })

    it('filters OpenTelemetry APIs from layer-specific externals', () => {
      const externals = applyToExternals({
        byLayer: {
          worker: {
            '@opentelemetry/api': 'module @opentelemetry/api',
            pg: 'commonjs pg',
          },
        },
      })

      assert.deepStrictEqual(externals[1], {
        byLayer: {
          worker: {
            pg: 'commonjs pg',
          },
        },
      })
    })

    it('bundles the holder fallback before user externals can match it', () => {
      const externals = applyToExternals({ '@opentelemetry/api': 'module @opentelemetry/api' })
      const holderDirectory = path.dirname(require.resolve('../../dd-trace/src/opentelemetry/api'))

      assert.strictEqual(resolveExternal(externals[0], holderDirectory, '@opentelemetry/api'), false)
    })

    for (const [name, userExternals] of [
      ['string', '@opentelemetry/api'],
      ['object', { '@opentelemetry/api': 'module @opentelemetry/api' }],
      ['function', userExternal],
      ['array', ['pg', { '@opentelemetry/api': 'module @opentelemetry/api' }]],
    ]) {
      it(`prioritizes the required ESM external over ${name} user externals`, () => {
        const externals = applyToExternals(userExternals, undefined, true)

        assert.strictEqual(
          resolveExternal(externals[0], '/app', '@opentelemetry/api'),
          'node-commonjs @opentelemetry/api'
        )
      })
    }

    for (const [name, userExternals] of [
      ['string', '@opentelemetry/api'],
      ['object', { '@opentelemetry/api': 'module @opentelemetry/api' }],
      ['function', userExternal],
      ['regular expression', /^@opentelemetry\/api$/],
      ['array', ['pg', { '@opentelemetry/api': 'module @opentelemetry/api' }]],
    ]) {
      it(`overrides ${name} user externals for a package the application does not own`, () => {
        const context = createManifestDirectory({ name: 'app', dependencies: {} })
        installPackage(context, '@opentelemetry/api', '1.9.0')

        const externals = applyToExternals(userExternals, context)

        assert.strictEqual(resolveExternal(externals[0], '/app', '@opentelemetry/api'), false)
        for (const external of externals.slice(1)) {
          assert.strictEqual(matchesExternal(external, '@opentelemetry/api'), false)
        }
      })
    }

    it('overrides wildcard user externals for API subpaths the application does not own', () => {
      const context = createManifestDirectory({ name: 'app', dependencies: {} })
      installPackage(context, '@opentelemetry/api', '1.9.0')
      const request = '@opentelemetry/api/experimental'
      const externals = applyToExternals(/^@opentelemetry\/api(?:\/.*)?$/, context)

      assert.strictEqual(resolveExternal(externals[0], '/app', request), false)
      assert.strictEqual(resolveExternal(externals[1], '/app', request), undefined)
    })

    it('externalizes only the package the application declares', () => {
      const context = createManifestDirectory({
        name: 'app',
        dependencies: { '@opentelemetry/api': '^1.9.0' },
      })
      installPackage(context, '@opentelemetry/api', '1.9.0')

      const externals = applyToExternals(undefined, context)

      assert.strictEqual(
        resolveExternal(externals[0], '/app', '@opentelemetry/api'),
        'commonjs @opentelemetry/api'
      )
      assert.strictEqual(
        resolveExternal(externals[0], '/app', '@opentelemetry/api/experimental'),
        'commonjs @opentelemetry/api/experimental'
      )
    })
  })

  describe('optional peer bundling', () => {
    /**
     * @param {string} [context]
     * @returns {(resolveData: {
     *   contextInfo?: { issuer?: string },
     *   createData: { loaders?: object[], resource?: string },
     *   request?: string
     * }) => void}
     */
    function captureAfterResolve (context) {
      const plugin = new DatadogWebpackPlugin()
      let afterResolve
      plugin.apply({
        options: { context, optimization: {} },
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

    it('marks the installed application API loader as application-owned', () => {
      const context = path.resolve(__dirname, '../../..')
      const resource = require.resolve('@opentelemetry/api')
      const moduleBaseDir = path.resolve(path.dirname(resource), '../..')
      const packageJson = JSON.parse(fs.readFileSync(path.join(moduleBaseDir, 'package.json'), 'utf8'))
      const createData = {
        resource,
      }

      captureAfterResolve(context)({
        contextInfo: { issuer: path.join(context, 'app.js') },
        createData,
        request: '@opentelemetry/api',
      })

      assert.deepStrictEqual(createData.loaders[0].options, {
        applicationOwned: true,
        moduleBaseDir,
        path: '@opentelemetry/api',
        pkg: '@opentelemetry/api',
        version: packageJson.version,
      })
    })

    it('does not apply the instrumentation loader to the fallback OpenTelemetry API', () => {
      const createData = {
        resource: require.resolve('../../../vendor/node_modules/@opentelemetry/api'),
      }

      captureAfterResolve()({ createData, request: '@opentelemetry/api' })

      assert.strictEqual(createData.loaders, undefined)
    })

    it('ignores modules without a resolved resource', () => {
      const createData = {}

      captureAfterResolve()({ createData })

      assert.strictEqual(createData.loaders, undefined)
    })
  })
})

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

describe('optionalPeerLoader', () => {
  it('rewrites an installed optional-peer load into a literal require', () => {
    const source = "const { DatadogNodeServerProvider } = requireOptionalPeer('@datadog/openfeature-node-server')"

    const result = optionalPeerLoader.call({ cacheable: () => {}, context: __dirname }, source)

    assert.ok(result.includes("require('@datadog/openfeature-node-server')"), 'should use a literal require')
    assert.ok(!result.includes('requireOptionalPeer('), 'should drop the opaque call')
  })
})
