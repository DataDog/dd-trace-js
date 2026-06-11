'use strict'

const assert = require('node:assert/strict')

const AzureCosmosPlugin = require('../src')

describe('azure-cosmos', () => {
  describe('getResource', () => {
    let plugin

    before(() => {
      plugin = new AzureCosmosPlugin({}, {})
    })

    it('replaces document id with ? while preserving db and container names', () => {
      const resource = plugin.getResource({
        operationType: 'delete',
        path: '/dbs/myDb/colls/myContainer/docs/test-id',
      })
      assert.strictEqual(resource, 'delete /dbs/myDb/colls/myContainer/docs/?')
    })

    it('replaces high-cardinality segments after resource types other than dbs or colls', () => {
      const resource = plugin.getResource({
        operationType: 'execute',
        path: '/dbs/myDb/colls/myContainer/sprocs/myStoredProc',
      })
      assert.strictEqual(resource, 'execute /dbs/myDb/colls/myContainer/sprocs/?')
    })

    it('does not modify path when there is no id segment after docs', () => {
      const path = '/dbs/myDb/colls/myContainer/docs'
      const resource = plugin.getResource({
        operationType: 'query',
        path,
      })
      assert.strictEqual(resource, `query ${path}`)
    })

    it('does not modify path when only database and container segments exist', () => {
      const path = '/dbs/myDb/colls/myContainer'
      const resource = plugin.getResource({
        operationType: 'read',
        path,
      })
      assert.strictEqual(resource, `read ${path}`)
    })
  })
})
