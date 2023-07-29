import 'dd-trace/init.js'
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://localhost:27017/test_db', { useUnifiedTopology: true })
await client.connect()
const db = client.db('test_db')
await db.collection('test_collection').insertOne({ a: 1 })
await client.close()
