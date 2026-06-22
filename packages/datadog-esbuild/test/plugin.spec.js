'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

const ddPlugin = require('../index')

function captureOpenFeatureOnLoad () {
  let onLoad
  ddPlugin.setup({
    initialOptions: {},
    onResolve () {},
    onLoad (options, callback) {
      if (options.filter.source.includes('flagging_provider')) onLoad = callback
    },
  })
  return onLoad
}

describe('datadog-esbuild plugin', () => {
  describe('openfeature peer bundling', () => {
    it('inlines a literal peer require for flagging_provider when the peer is installed', () => {
      const onLoad = captureOpenFeatureOnLoad()
      const providerPath = require.resolve('../../dd-trace/src/openfeature/flagging_provider')

      const result = onLoad({ path: providerPath })

      assert.ok(result.contents.includes("require('@datadog/openfeature-node-server')"), 'should inline the peer')
      assert.ok(!result.contents.includes('runtimeRequire(openfeatureNodeServerPath)'), 'should drop the opaque load')
    })

    it('ignores files that match the filter but are not the provider', () => {
      const onLoad = captureOpenFeatureOnLoad()

      assert.strictEqual(onLoad({ path: '/somewhere/else/flagging_provider.js' }), undefined)
    })

    it('leaves the provider opaque when the peer is not installed', () => {
      const onLoad = captureOpenFeatureOnLoad()
      const noPeerPath = '/tmp/dd-trace-no-peer/packages/dd-trace/src/openfeature/flagging_provider.js'

      assert.strictEqual(onLoad({ path: noPeerPath }), undefined)
    })
  })
})
