import 'dd-trace/init.js'
import MongoDBCore from 'mongodb-core'

const server = new MongoDBCore.Server({
  host: 'localhost',
  port: 27017,
  reconnect: false
})

const connectPromise = new Promise((resolve, reject) => {
  server.on('connect', () => { resolve() })
  server.on('error', (err) => { reject(err) })
})

await server.connect()
await connectPromise

server.insert('test.your_collection_name', [{ a: 1 }], {}, (err) => {
  if (err) {
    return
  }
  server.destroy(() => {})
})

