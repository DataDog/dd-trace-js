'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const produceStartCh = channel('apm:bullmq:produce:start')
const produceFinishCh = channel('apm:bullmq:produce:finish')
const produceErrorCh = channel('apm:bullmq:produce:error')
const receiveStartCh = channel('apm:bullmq:receive:start')
const receiveFinishCh = channel('apm:bullmq:receive:finish')
const receiveErrorCh = channel('apm:bullmq:receive:error')

function makeWrapSend () {
  return function wrapSend (sendOriginal) {
    return function wrapped () {
      if (!produceStartCh.hasSubscribers) {
        return sendOriginal.apply(this, arguments)
      }
      const ctx = {}
      // TODO: Extract relevant data from arguments
      return produceStartCh.runStores(ctx, () => {
        try {
          const result = sendOriginal.apply(this, arguments)
          produceFinishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          produceErrorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}
function makeWrapAdd () {
  return function wrapAdd (addOriginal) {
    return function wrapped () {
      if (!produceStartCh.hasSubscribers) {
        return addOriginal.apply(this, arguments)
      }
      const ctx = {}
      // TODO: Extract relevant data from arguments
      return produceStartCh.runStores(ctx, () => {
        try {
          const result = addOriginal.apply(this, arguments)
          produceFinishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          produceErrorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}
function makeWrapOn () {
  return function wrapOn (onOriginal) {
    return function wrapped () {
      if (!receiveStartCh.hasSubscribers) {
        return onOriginal.apply(this, arguments)
      }
      const ctx = {}
      // TODO: Extract relevant data from arguments
      return receiveStartCh.runStores(ctx, () => {
        try {
          const result = onOriginal.apply(this, arguments)
          receiveFinishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          receiveErrorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}

addHook({ name: 'bullmq', file: 'dist/cjs/classes/child.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetChild = bullmq.Child
  if (targetChild && typeof targetChild.send === 'function') {
    shimmer.wrap(targetChild, 'send', makeWrapSend())
  }
  return bullmq
})

addHook({ name: 'bullmq', file: 'dist/cjs/classes/async-fifo-queue.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetAsyncFifoQueue = bullmq.AsyncFifoQueue
  if (targetAsyncFifoQueue && typeof targetAsyncFifoQueue.add === 'function') {
    shimmer.wrap(targetAsyncFifoQueue, 'add', makeWrapAdd())
  }
  return bullmq
})

addHook({ name: 'bullmq', file: 'dist/cjs/classes/flow-producer.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetFlowProducer = bullmq.FlowProducer
  if (targetFlowProducer && typeof targetFlowProducer.on === 'function') {
    shimmer.wrap(targetFlowProducer, 'on', makeWrapOn())
  }
  if (targetFlowProducer && typeof targetFlowProducer.add === 'function') {
    shimmer.wrap(targetFlowProducer, 'add', makeWrapAdd())
  }
  return bullmq
})

addHook({ name: 'bullmq', file: 'dist/cjs/classes/queue-events.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetQueueEvents = bullmq.QueueEvents
  if (targetQueueEvents && typeof targetQueueEvents.on === 'function') {
    shimmer.wrap(targetQueueEvents, 'on', makeWrapOn())
  }
  return bullmq
})

addHook({ name: 'bullmq', file: 'dist/cjs/classes/queue.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetQueue = bullmq.Queue
  if (targetQueue && typeof targetQueue.on === 'function') {
    shimmer.wrap(targetQueue, 'on', makeWrapOn())
  }
  if (targetQueue && typeof targetQueue.add === 'function') {
    shimmer.wrap(targetQueue, 'add', makeWrapAdd())
  }
  return bullmq
})

addHook({ name: 'bullmq', file: 'dist/cjs/classes/worker.js', versions: ['>=0'] }, (bullmq) => {
  // TODO: if methods live on a prototype, set target to
  // target.prototype; otherwise use export directly
  // Conservative approach: try multiple target patterns for version compatibility
  const targetWorker = bullmq.Worker
  if (targetWorker && typeof targetWorker.on === 'function') {
    shimmer.wrap(targetWorker, 'on', makeWrapOn())
  }
  return bullmq
})
