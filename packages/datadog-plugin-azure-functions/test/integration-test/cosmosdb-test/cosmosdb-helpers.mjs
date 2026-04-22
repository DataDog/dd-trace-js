import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CosmosClient } from '@azure/cosmos'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

function getMyCosmosDbConnection () {
  const settingsPath = join(__dirname, '../../fixtures/local.settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  return settings.Values.MyCosmosDB
}

export async function setup () {
  const client = new CosmosClient(getMyCosmosDbConnection())
  await client.databases.createIfNotExists({ id: 'testDatabase' })
  await client.database('testDatabase').containers.createIfNotExists({
    id: 'testContainer',
    partitionKey: { paths: ['/productName'], kind: 'Hash' },
  })
}

export async function teardown () {
  const client = new CosmosClient(getMyCosmosDbConnection())
  await client.database('testDatabase').delete()
}
