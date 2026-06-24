'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')

const {
  OPTIONAL_PEER_FILES,
  OPTIONAL_PEER_FILTER,
  matchesOptionalPeerFile,
  rewriteOptionalPeerLoads,
} = require('../../src/helpers/optional-peer-bundler')

describe('optional-peer-bundler', () => {
  describe('rewriteOptionalPeerLoads', () => {
    it('turns an installed peer load into a literal require', () => {
      const source = "const x = requireOptionalPeer('@datadog/openfeature-node-server')"

      assert.strictEqual(
        rewriteOptionalPeerLoads(source, __dirname),
        "const x = require('@datadog/openfeature-node-server')"
      )
    })

    it('leaves an absent peer load opaque', () => {
      const source = "const x = requireOptionalPeer('@datadog/this-peer-is-not-installed')"

      assert.strictEqual(rewriteOptionalPeerLoads(source, __dirname), source)
    })

    it('leaves source without an optional-peer load unchanged', () => {
      const source = "const fs = require('node:fs')"

      assert.strictEqual(rewriteOptionalPeerLoads(source, __dirname), source)
    })
  })

  describe('matchesOptionalPeerFile', () => {
    it('matches a registered optional-peer file suffix', () => {
      assert.strictEqual(
        matchesOptionalPeerFile('/app/node_modules/dd-trace/packages/dd-trace/src/openfeature/flagging_provider.js'),
        true
      )
    })

    it('does not match an unrelated module in the same directory', () => {
      assert.strictEqual(matchesOptionalPeerFile('/app/packages/dd-trace/src/openfeature/index.js'), false)
    })
  })

  describe('OPTIONAL_PEER_FILTER', () => {
    it('matches the basename of every registered file', () => {
      for (const file of OPTIONAL_PEER_FILES) {
        assert.match(path.basename(file), OPTIONAL_PEER_FILTER)
      }
    })
  })
})
