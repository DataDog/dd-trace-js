import 'dd-trace/init.js'
import {
  Bucket,
  Cluster,
  Collection,
  connect,
  GetResult
} from 'couchbase'

async function main () {
  const cluster = await connect(
    'couchbase://127.0.0.1',
    {
      username: 'Administrator',
      password: 'password'
    })

  const bucket = cluster.bucket('datadog-test')
  const coll = bucket.defaultCollection()
  await coll.upsert('testdoc', { name: 'Frank' })
}

// Run the main function
main()
  .then((_) => {
    console.log('Success!')
  })
  .catch((err) => {
    console.log('ERR:', err)
  })
