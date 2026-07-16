import 'dd-trace/init.js'
import { app } from '@azure/functions'
import { CosmosClient } from '@azure/cosmos'

const client = new CosmosClient(process.env.MyCosmosDB)
const database = client.database('testDatabase')
const container = database.container('testContainer')

app.http('writeToCosmos', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'writeToCosmos',
  handler: async (request, context) => {
    await container.items.upsert({
      id: 'item1',
      productName: 'Test Product',
      productModel: 'Model 1',
    })

    return { status: 200, body: 'Success: ' }
  },
})

app.cosmosDB('cosmosDBTrigger1', {
  connection: 'MyCosmosDB',
  databaseName: 'testDatabase',
  containerName: 'testContainer',
  createLeaseContainerIfNotExists: true,
  handler: (documents, context) => {
    return {
      status: 200,
    }
  },
})
