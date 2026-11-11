'use strict'

const {
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero,
  PATHWAY_FIELD_BYTES,
} = require('./size')

// This is only needed because DSM code is spread across existing tracing
// plugins instead of having dedicated DSM plugins that are themselves
// lazy loaded.
//
// TODO: Remove this when DSM has been moved to dedicated plugins.
/**
 * @template T extends new (...args: unknown[]) => unknown
 * @param {() => T} classGetter
 * @param {string[]} methods
 * @param {string[]} staticMethods
 * @returns {T}
 */
function lazyClass (classGetter, methods = [], staticMethods = []) {
  let ActiveClass

  const activate = () => {
    ActiveClass ??= classGetter()
    return ActiveClass
  }

  class LazyClass {
    /** @type {unknown[] | undefined} */
    #args

    /** @param {...unknown} args */
    constructor (...args) {
      this.#args = args
    }

    static {
      for (const method of methods) {
        this.prototype[method] = function (...args) {
          let instance = Object.getPrototypeOf(this)
          if (this.#args !== undefined) {
            instance = new (activate())(...this.#args)
            this.#args = undefined
            Object.setPrototypeOf(this, instance)
          }

          return instance[method].apply(this, args)
        }
      }
    }
  }

  for (const method of staticMethods) {
    LazyClass[method] = function (...args) {
      LazyClass[method] = activate() && ActiveClass[method]

      return LazyClass[method](...args)
    }
  }

  return /** @type {T} */ (/** @type {unknown} */ (LazyClass))
}

/**
 * @type {typeof import('./pathway').DsmPathwayCodec}
 */
const DsmPathwayCodec = lazyClass(() => require('./pathway').DsmPathwayCodec, [], [
  'encode',
  'decode',
])

/**
 * @type {typeof import('./checkpointer').DataStreamsCheckpointer}
 */
const DataStreamsCheckpointer = lazyClass(() => require('./checkpointer').DataStreamsCheckpointer, [
  'setProduceCheckpoint',
  'setConsumeCheckpoint',
  'trackTransaction',
])

/**
 * @type {typeof import('./manager').DataStreamsManager}
 */
const DataStreamsManager = lazyClass(() => require('./manager').DataStreamsManager, [
  'setCheckpoint',
  'decodeDataStreamsContext',
  'trackTransaction',
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
  'trackTransaction',
  'trySampleSchema',
  'canSampleSchema',
  'getSchema',
])

/**
 * @type {typeof import('./schemas/schema_builder').SchemaBuilder}
 */
const SchemaBuilder = lazyClass(() => require('./schemas/schema_builder').SchemaBuilder, [
  'build',
  'addProperty',
  'shouldExtractSchema',
], [
  'getCache',
  'getSchemaDefinition',
  'getSchema',
])

module.exports = {
  DsmPathwayCodec,
  DataStreamsCheckpointer,
  DataStreamsManager,
  DataStreamsProcessor,
  SchemaBuilder,
  PATHWAY_FIELD_BYTES,

  // These are small functions so they are exposed directly and not lazy loaded.
  getAmqpMessageSize,
  getHeadersSize,
  getMessageSize,
  getSizeOrZero,
}
