import 'dd-trace/init.js'
import { default as mongoose } from 'mongoose'

const testSchema = new mongoose.Schema({
  a: Number
})
const TestModel = mongoose.model('Test', testSchema)

await mongoose.connect('mongodb://localhost:27017/test_db', { useNewUrlParser: true, useUnifiedTopology: true })
await TestModel.create({ a: 1 })
await mongoose.disconnect()

