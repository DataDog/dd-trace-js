import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import mongoose from 'mongoose'

const testSchema = new mongoose.Schema({
  a: Number
})
const TestModel = mongoose.model('Test', testSchema)

pluginHelpers.onMessage(async () => {
  await mongoose.connect('mongodb://localhost:27017/test_db', { useNewUrlParser: true, useUnifiedTopology: true })
  await TestModel.create({ a: 1 })
  await mongoose.disconnect()
})
