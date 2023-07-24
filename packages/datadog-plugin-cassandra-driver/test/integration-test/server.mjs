import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import { Client } from 'cassandra-driver'

let client

pluginHelpers.onMessage(async () => {
  client = new Client({
    contactPoints: ['127.0.0.1'],
    localDataCenter: 'datacenter1',
    keyspace: 'system'
  })

  await client.connect()
  await client.execute('SELECT now() FROM local;')
  await client.shutdown()
})
