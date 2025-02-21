'use strict'

const {
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero
} = require('./size')

function lazyClass (classGetter, methods = [], staticMethods = []) {
  let constructorArgs

  const LazyClass = function (...args) {
    constructorArgs = args
  }

  for (const method of methods) {
    LazyClass.prototype[method] = function (...args) {
      const ActiveClass = classGetter()
      const instance = new ActiveClass(...constructorArgs)

      Object.setPrototypeOf(this, instance)

      return this[method](...args)
    }
  }

  for (const method of staticMethods) {
    LazyClass[method] = function (...args) {
      const ActiveClass = classGetter()

      for (const method of staticMethods) {
        LazyClass[method] = ActiveClass[method]
      }

      return LazyClass[method](...args)
    }
  }

  return LazyClass
}

const DsmPathwayCodec = lazyClass(() => require('./pathway').DsmPathwayCodec, [], [
  'encode',
  'decode'
])

const DataStreamsCheckpointer = lazyClass(() => require('./checkpointer').DataStreamsCheckpointer, [
  'setProduceCheckpoint',
  'setConsumeCheckpoint'
])

const DataStreamsManager = lazyClass(() => require('./manager').DataStreamsManager, [
  'setCheckpoint',
  'decodeDataStreamsContext'
])

// TODO: Are all those methods actually public?
const DataStreamsProcessor = lazyClass(() => require('./processor').DataStreamsProcessor, [
  'onInterval',
  'bucketFromTimestamp',
  'recordCheckpoint',
  'setCheckpoint',
  'recordOffset',
  'setOffset',
  'setUrl',
  'trySampleSchema',
  'canSampleSchema',
  'getSchema'
])

const SchemaBuilder = lazyClass(() => require('./schemas/schema_builder').SchemaBuilder, [
  'build',
  'addProperty',
  'shouldExtractSchema'
], [
  'getCache',
  'getSchemaDefinition',
  'getSchema'
])

module.exports = {
  DsmPathwayCodec,
  DataStreamsCheckpointer,
  DataStreamsManager,
  DataStreamsProcessor,
  SchemaBuilder,
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero
}
