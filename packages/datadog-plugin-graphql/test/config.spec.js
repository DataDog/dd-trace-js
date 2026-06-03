'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

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

function countListIndicesFor (plugin, options) {
  plugin.configure({ depth: 2, ...options })
  return plugin.resolve.config.countListIndices
}

// Build a graphql-style path linked list ({ prev, key }) from root to leaf.
function makePath (...keys) {
  let node
  for (const key of keys) node = { prev: node, key }
  return node
}

// start() bails out and returns undefined when the path is deeper than the limit,
// before touching the tracer, so it exercises the depth count without a real span.
function isGated (plugin, options, path) {
  plugin.configure({ depth: 2, ...options })
  return plugin.resolve.start({ path }) === undefined
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

  describe('depth counting honours the gate', () => {
    it('counts the list index on v5, so friends.0.name exceeds depth 2', () => {
      const plugin = loadPluginFor(5)
      assert.strictEqual(isGated(plugin, { collapse: true }, makePath('friends', 0, 'name')), true)
    })

    it('counts field segments only on v6, so three fields exceed depth 2', () => {
      const plugin = loadPluginFor(6)
      assert.strictEqual(isGated(plugin, { collapse: true }, makePath('human', 'address', 'street')), true)
    })
  })
})
