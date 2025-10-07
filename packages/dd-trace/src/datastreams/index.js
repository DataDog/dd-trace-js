'use strict'

const {
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero
} = require('./size')

// This is only needed because DSM code is spread across existing tracing
// plugins instead of having dedicated DSM plugins that are themselves
// lazy loaded.
//
// TODO: Remove this when DSM has been moved to dedicated plugins.
/**
 * @template T extends new (...args: any[]) => any
 * @param {() => T} classGetter
 * @param {string[]} methods
 * @param {string[]} staticMethods
 * @returns {T}
 */
function lazyClass (classGetter, methods = [], staticMethods = []) {
  let constructorArgs
  let ActiveClass

  const LazyClass = function (...args) {
    constructorArgs = args
  }

  const activate = () => {
    return (ActiveClass = ActiveClass || classGetter())
  }

  for (const method of methods) {
    LazyClass.prototype[method] = function (...args) {
      const instance = activate() && new ActiveClass(...constructorArgs)

      // Replace the whole prototype instead of only the method itself whenever
      // any individual method is called to avoid running through this code
      // again every time another method is called. This is not only more
      // efficient but it also means that the class instance does not need to be
      // stored for future calls to other methods.
      Object.setPrototypeOf(this, instance)

      return this[method](...args)
    }
  }

  for (const method of staticMethods) {
    LazyClass[method] = function (...args) {
      LazyClass[method] = activate() && ActiveClass[method]

      return LazyClass[method](...args)
    }
  }

  return LazyClass
}

/**
 * @type {typeof import('./pathway').DsmPathwayCodec}
 */
const DsmPathwayCodec = lazyClass(() => require('./pathway').DsmPathwayCodec, [], [
  'encode',
  'decode'
])

/**
 * @type {typeof import('./checkpointer').DataStreamsCheckpointer}
 */
const DataStreamsCheckpointer = lazyClass(() => require('./checkpointer').DataStreamsCheckpointer, [
  'setProduceCheckpoint',
  'setConsumeCheckpoint'
])

/**
 * @type {typeof import('./manager').DataStreamsManager}
 */
const DataStreamsManager = lazyClass(() => require('./manager').DataStreamsManager, [
  'setCheckpoint',
  'decodeDataStreamsContext'
])

// TODO: Are all those methods actually public?
/**
 * @type {typeof import('./processor').DataStreamsProcessor}
 */
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

/**
 * @type {typeof import('./schemas/schema_builder').SchemaBuilder}
 */
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

  // These are small functions so they are exposed directly and not lazy loaded.
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero
}
