const { CosmosClient } = require('@azure/cosmos')

async function setup() {
  const client = new CosmosClient({
    endpoint: 'https://localhost:8081',
    key: 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
  })

  const database = client.database({ id: 'testDatabase' })
  const container = database.container({
    id: 'testContainer',
    partitionKey: {
      paths: ['/productName'],
      kind: 'Hash',
    },
  })

  return { client, database, container }
}

async function teardown(client, database) {
  await database.delete()
  await client.close()
}

module.exports = { setup, teardown }
