'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

describe('registry', () => {
  let registry

  before(() => {
    registry = require('../src/registry')
  })

  it('should auto-discover orchestrion configs from integrations directory', () => {
    assert.ok(Array.isArray(registry.orchestrion))
    assert.ok(registry.orchestrion.length > 0)

    const sharedbEntry = registry.orchestrion.find(e => e.module.name === 'sharedb')
    assert.ok(sharedbEntry, 'should include sharedb orchestrion config')
    assert.strictEqual(sharedbEntry.channelName, 'Agent__handleMessage')
  })

  it('should auto-discover plugins from integrations directory', () => {
    assert.ok(registry.plugins.sharedb, 'should include sharedb plugin')
    assert.strictEqual(registry.plugins.sharedb.id, 'sharedb')
  })

  it('should generate hook entries for each module name', () => {
    assert.strictEqual(typeof registry.hookEntries.sharedb, 'function')
  })

  it('should not include non-js files or directories', () => {
    for (const entry of registry.orchestrion) {
      assert.ok(entry.module.name, 'every orchestrion entry should have a module name')
    }
  })
})
