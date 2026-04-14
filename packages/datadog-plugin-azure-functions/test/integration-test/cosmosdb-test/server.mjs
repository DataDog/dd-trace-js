import 'dd-trace/init.js'
import { app } from '@azure/functions'



app.cosmosDB('cosmosDBTrigger1', {
  connection: process.env.MyCosmosDB,
  databaseName: 'TestDatabase',
  containerName: 'TestContainer',
  createLeaseContainerIfNotExists: true,
  handler: (documents, context) => {
    return {
      status: 200,
    }
  },
});
