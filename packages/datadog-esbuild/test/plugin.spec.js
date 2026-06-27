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
      if (options.filter.source.includes('flagging_provider')) onLoad = callback
    },
  })
  return onLoad
}

function setupExternal (initialOptions = {}) {
  ddPlugin.setup({ initialOptions, onResolve () {}, onLoad () {} })
  return initialOptions.external
}

describe('datadog-esbuild plugin', () => {
  describe('OpenTelemetry API externalization', () => {
    it('marks both OpenTelemetry API peers external so the bundle shares the application copy', () => {
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
  })

  describe('optional peer bundling', () => {
    it('rewrites the installed peer load in flagging_provider into a literal require', () => {
      const onLoad = captureOptionalPeerOnLoad()
      const providerPath = require.resolve('../../dd-trace/src/openfeature/flagging_provider')

      const result = onLoad({ path: providerPath })

      assert.ok(result.contents.includes("require('@datadog/openfeature-node-server')"), 'should inline the peer')
      assert.ok(
        !result.contents.includes("requireOptionalPeer('@datadog/openfeature-node-server')"),
        'should drop the opaque load'
      )
    })

    it('ignores files that match the filter but are not an optional-peer file', () => {
      const onLoad = captureOptionalPeerOnLoad()

      assert.strictEqual(onLoad({ path: '/somewhere/else/flagging_provider.js' }), undefined)
    })
  })
})
