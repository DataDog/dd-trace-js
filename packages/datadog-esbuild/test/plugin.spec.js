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

function captureOnResolve () {
  let onResolve
  ddPlugin.setup({
    initialOptions: {},
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
