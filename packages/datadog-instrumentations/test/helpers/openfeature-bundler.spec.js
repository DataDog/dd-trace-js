'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')

const {
  OPENFEATURE_PEER,
  isOpenFeaturePeerInstalled,
  rewriteFlaggingProviderSource,
} = require('../../src/helpers/openfeature-bundler')

describe('openfeature-bundler', () => {
  describe('rewriteFlaggingProviderSource', () => {
    const opaqueSource = [
      "const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require",
      "const openfeatureNodeServer = ['@datadog/openfeature', 'node', 'server'].join('-')",
      'const openfeatureNodeServerPath = runtimeRequire.resolve(openfeatureNodeServer, { paths: [__dirname] })',
      'const { DatadogNodeServerProvider } = runtimeRequire(openfeatureNodeServerPath)',
    ].join('\n')

    it('turns the opaque peer load into a literal require', () => {
      const result = rewriteFlaggingProviderSource(opaqueSource)

      assert.ok(result.includes(`require('${OPENFEATURE_PEER}')`), 'should use a literal require')
      assert.ok(!result.includes('runtimeRequire(openfeatureNodeServerPath)'), 'should drop the opaque require')
      assert.ok(!result.includes('runtimeRequire.resolve('), 'should drop the opaque resolve so it cannot throw')
    })

    it('throws when the provider load shape no longer matches', () => {
      assert.throws(
        () => rewriteFlaggingProviderSource("const x = require('something-else')"),
        /OpenFeature provider load shape changed/
      )
    })
  })

  describe('isOpenFeaturePeerInstalled', () => {
    it('returns true when the peer resolves from the directory', () => {
      assert.strictEqual(isOpenFeaturePeerInstalled(__dirname), true)
    })

    it('returns false when the peer does not resolve from the directory', () => {
      assert.strictEqual(isOpenFeaturePeerInstalled(path.parse(__dirname).root), false)
    })
  })
})
