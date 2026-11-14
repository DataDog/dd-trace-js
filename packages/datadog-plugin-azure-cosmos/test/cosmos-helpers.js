'use strict'

/**
 * @param {string} version
 */
async function setup (version) {
  const { CosmosClient } = require(`../../../versions/@azure/cosmos@${version}`).get()
  const client = new CosmosClient({
    endpoint: 'http://127.0.0.1:8081',
    key: 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
  })

  const { database } = await client.databases.createIfNotExists({ id: 'testDatabase' })
  const { container } = await database.containers.createIfNotExists({
    id: 'testContainer',
    partitionKey: { paths: ['/productName'], kind: 'Hash' },
  })

  return { client, container }
}

async function teardown (client) {
  await client.database('testDatabase').delete()
}

module.exports = { setup, teardown }
