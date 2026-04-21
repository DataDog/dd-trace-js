'use strict'

async function setup () {
  const { CosmosClient } = require('@azure/cosmos')
  const client = new CosmosClient({
    endpoint: 'localhost:8081',
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
