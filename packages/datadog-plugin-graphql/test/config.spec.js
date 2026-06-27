'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

// `countListIndices` decides whether numeric list-index path segments count toward
// the resolver `depth` limit. The v5 release line counts them when collapsing; v6
// never does, so depth always tracks selection-set nesting. The behaviour is gated
// on DD_MAJOR, so stub the version constant to reach both arms on either release line.
function loadPluginFor (DD_MAJOR) {
  const GraphQLPlugin = proxyquire('../src', {
    '../../../version': { DD_MAJOR, '@noCallThru': true },
  })

  return new GraphQLPlugin({}, {})
}

// CompositePlugin spreads the validated config into every sub-plugin, so the
// execute plugin (which carries the depth gate) sees `countListIndices`.
function countListIndicesFor (plugin, options) {
  plugin.configure({ depth: 2, ...options })
  return plugin.execute.config.countListIndices
}

describe('graphql plugin depth/collapse gate', () => {
  describe('v5 (DD_MAJOR < 6)', () => {
    let plugin

    before(() => {
      plugin = loadPluginFor(5)
    })

    it('counts collapsed list indices toward depth (collapse defaults on)', () => {
      assert.strictEqual(countListIndicesFor(plugin, {}), true)
      assert.strictEqual(countListIndicesFor(plugin, { collapse: true }), true)
    })

    it('counts only field segments when collapsing is disabled', () => {
      assert.strictEqual(countListIndicesFor(plugin, { collapse: false }), false)
    })
  })

  describe('v6 (DD_MAJOR >= 6)', () => {
    let plugin

    before(() => {
      plugin = loadPluginFor(6)
    })

    it('never counts list indices, regardless of collapse', () => {
      assert.strictEqual(countListIndicesFor(plugin, {}), false)
      assert.strictEqual(countListIndicesFor(plugin, { collapse: true }), false)
      assert.strictEqual(countListIndicesFor(plugin, { collapse: false }), false)
    })
  })
})
