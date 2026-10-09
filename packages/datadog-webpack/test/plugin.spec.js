'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')

const DatadogWebpackPlugin = require('../index')
const loader = require('../src/loader')

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

    it('adds the loader to bundler-activated packages without hooks', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webpack-'))
      const packageDirectory = path.join(directory, 'node_modules', 'ai')
      fs.mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: '6.0.0' }))
      fs.writeFileSync(path.join(packageDirectory, 'dist', 'index.js'), 'module.exports = {}\n')

      let afterResolve
      new DatadogWebpackPlugin().apply({
        options: {},
        hooks: {
          environment: { tap: () => {} },
          thisCompilation: { tap: () => {} },
          normalModuleFactory: {
            tap: (name, fn) => fn({ hooks: { afterResolve: { tap: (name, hook) => { afterResolve = hook } } } }),
          },
        },
      })

      try {
        const createData = { resource: path.join(packageDirectory, 'dist', 'index.js') }
        afterResolve({ request: 'ai', createData })

        assert.deepStrictEqual(createData.loaders, [{
          loader: require.resolve('../src/loader'),
          options: { pkg: 'ai', version: '6.0.0', path: 'ai' },
        }])
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
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
