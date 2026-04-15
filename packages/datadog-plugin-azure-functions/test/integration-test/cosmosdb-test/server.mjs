import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { CosmosClient } from '@azure/cosmos'

let client
let container
let database

async function setup() {
  client = new CosmosClient(process.env.MyCosmosDB)

  database = await client.databases.createIfNotExists({ id: 'testDatabase' })
  container = await database.containers.createIfNotExists({
    id: 'testContainer',
    partitionKey: { paths: ['/productName'], kind: 'Hash' },
  })
}

async function teardown() {
  await client.database('testDatabase').delete()
}

app.http('writeToCosmos', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'writeToCosmos',
  handler: async (request, context) => {
    context.log('Node HTTP trigger processed a request (Cosmos parity with function_app.py).');

    container.items.upsert({
      id: 'item1',
      productName: 'Test Product',
      productModel: 'Model 1',
    })

    return { status: 200, body: 'Success: ' };

  },
});

app.cosmosDB('cosmosDBTrigger1', {
  connection: process.env.MyCosmosDB,
  databaseName: 'testDatabase',
  containerName: 'testContainer',
  createLeaseContainerIfNotExists: true,
  handler: (documents, context) => {
    return {
      status: 200,
    }
  },
})

export { setup, teardown }
