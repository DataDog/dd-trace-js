import 'dd-trace/init.js'
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://127.0.0.1:27017')
await client.connect()
const db = client.db('test_db')
const collection = db.collection('test_collection')
collection.insertOne({ a: 1 }, {}, () => {})
setTimeout(() => { client.close() }, 1500)

