import 'dd-trace/init.js'
import couchbase from 'couchbase'

N1qlQuery = couchbase.N1qlQuery
            cluster = new couchbase.Cluster('localhost:8091')
            cluster.authenticate('Administrator', 'password')
            cluster.enableCbas('localhost:8095')
            bucket = cluster.openBucket('datadog-test', (err) => done(err))

await collection.get('foo')

cluster.close()

process.send({ port: -1 })
