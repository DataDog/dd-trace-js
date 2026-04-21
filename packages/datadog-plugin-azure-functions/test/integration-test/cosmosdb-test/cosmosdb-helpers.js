'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { CosmosClient } = require('@azure/cosmos')

function getMyCosmosDbConnection () {
  const settingsPath = join(__dirname, '../../fixtures/local.settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  return settings.Values.MyCosmosDB
}

async function setup () {
  const client = new CosmosClient(getMyCosmosDbConnection())
  await client.databases.createIfNotExists({ id: 'testDatabase' })
  await client.database('testDatabase').containers.createIfNotExists({
    id: 'testContainer',
    partitionKey: { paths: ['/productName'], kind: 'Hash' },
  })
}

async function teardown () {
  const client = new CosmosClient(getMyCosmosDbConnection())
  await client.database('testDatabase').delete()
}

module.exports = { setup, teardown }
