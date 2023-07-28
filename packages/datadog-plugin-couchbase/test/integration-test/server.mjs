import 'dd-trace/init.js'
import couchbase from 'couchbase'

const cluster = new couchbase.Cluster('localhost:8091')
cluster.authenticate('Administrator', 'password')
const bucket = cluster.bucket('datadog-test')
const collection = bucket.defaultCollection();

await collection.get('foo')

cluster.close()

process.send({ port: -1 })
