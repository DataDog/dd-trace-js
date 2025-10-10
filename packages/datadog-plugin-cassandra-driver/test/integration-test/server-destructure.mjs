import 'dd-trace/init.js'
import { Client } from 'cassandra-driver'
const cassandra = { Client }

const client = new cassandra.Client({
  contactPoints: ['127.0.0.1'],
  localDataCenter: 'datacenter1',
  keyspace: 'system'
})

await client.connect()
await client.execute('SELECT now() FROM local;')
await client.shutdown()

