'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

describe('sharedb createIntegration descriptor', () => {
  const sharedb = require('../../src/integrations/sharedb')

  it('should export orchestrion, plugin, and hooks', () => {
    assert.ok(Array.isArray(sharedb.orchestrion))
    assert.ok(typeof sharedb.plugin === 'function')
    assert.ok(Array.isArray(sharedb.hooks))
  })

  it('should have correct orchestrion config', () => {
    assert.strictEqual(sharedb.orchestrion.length, 1)
    assert.deepStrictEqual(sharedb.orchestrion[0].module, {
      name: 'sharedb',
      versionRange: '>=1',
      filePath: 'lib/agent.js',
    })
    assert.deepStrictEqual(sharedb.orchestrion[0].functionQuery, {
      kind: 'Callback',
      index: 1,
    })
    assert.strictEqual(sharedb.orchestrion[0].channelName, 'Agent__handleMessage')
    assert.strictEqual(
      sharedb.orchestrion[0].astQuery,
      'AssignmentExpression[left.property.name="_handleMessage"] > FunctionExpression'
    )
  })

  it('should have correct hooks config', () => {
    assert.deepStrictEqual(sharedb.hooks, [{
      name: 'sharedb',
      versions: ['>=1'],
      file: 'lib/agent.js',
    }])
  })

  it('should have a plugin class with correct id and prefix', () => {
    assert.strictEqual(sharedb.plugin.id, 'sharedb')
    assert.strictEqual(sharedb.plugin.prefix, 'tracing:orchestrion:sharedb:Agent__handleMessage')
  })
})
