import 'dd-trace/init.js'
import couch from 'couchbase'

const cluster = await couch.connect(
  'couchbase://127.0.0.1',
  {
    username: 'Administrator',
    password: 'password',
  })

const bucket = cluster.bucket('datadog-test')
const coll = bucket.defaultCollection()
await coll.upsert('testdoc', { name: 'Frank' })
