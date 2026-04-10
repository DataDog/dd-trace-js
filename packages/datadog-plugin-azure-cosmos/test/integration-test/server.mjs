import 'dd-trace/init.js'
import { CosmosClient } from '@azure/cosmos'

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

await container.items.create({ id: '1', productName: 'Test Product', productModel: 'Model 1' })

const deleteQuery = {
  query: 'SELECT * FROM testContainer p WHERE p.productModel = "Model 1"',
};
const { resources: toDelete } = await container.items
  .query(deleteQuery, { enableCrossPartitionQuery: true })
  .fetchAll();
for (const item of toDelete) {
  await container.item(item.id, 'Test Product').delete();
}
