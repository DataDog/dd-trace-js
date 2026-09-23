'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)

// Bootstrap only the lifecycle registry, never the tracer or its preload entrypoints.
globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }

const { configureWorkerTelemetry } = require('./flag-evaluation-telemetry')
const state = new Int32Array(workerData.state)
configureWorkerTelemetry(state)
const FlagEvaluationConsumer = require('./flag-evaluation-consumer')

/** @param {object} route */
function deserializeRoute (route) {
  return { ...route, url: new URL(route.url), fallback: route.fallback && deserializeRoute(route.fallback) }
}

const route = deserializeRoute(workerData.route)
const consumer = new FlagEvaluationConsumer({ ...workerData.context, url: route.url }, route, {
  onProcessed: count => Atomics.sub(state, 0, count),
  onDelivered: count => Atomics.sub(state, 1, count),
  onIdle: () => port.close(),
})
consumer.setEnabled(true, route)
port.on('message', message => {
  switch (message.type) {
    case 'batch':
      for (const event of message.events) {
        if (!consumer.enqueue(event)) Atomics.sub(state, 0, 1)
      }
      break
    case 'enabled':
      consumer.setEnabled(message.enabled, message.route && deserializeRoute(message.route))
      break
    case 'flush':
      consumer.flush()
      break
    case 'close':
      consumer.destroy()
      break
  }
})
