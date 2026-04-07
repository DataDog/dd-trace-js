'use strict'

const assert = require('node:assert/strict')
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
