'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort)

// Bootstrap only the lifecycle registry, never the tracer or its preload entrypoints.
globalThis[Symbol.for('dd-trace')] = { beforeExitHandlers: new Set() }

const { configureWorkerTelemetry } = require('./flag-evaluation-telemetry')
const state = new Int32Array(workerData.state)
configureWorkerTelemetry(state)
const FlagEvaluationConsumer = require('./flag-evaluation-consumer')

/** @param {import('./flag-evaluations').SerializedFlagEvaluationRoute} route */
function deserializeRoute (route) {
  return {
    url: new URL(route.url),
    basePath: route.basePath,
    headers: route.headers,
    fallback: route.fallback && deserializeRoute(route.fallback),
    onFallback: route.onFallback
      ? () => port.postMessage({ type: 'route', id: route.id, status: 'fallback' })
      : undefined,
    onUnavailable: route.onUnavailable
      ? () => port.postMessage({ type: 'route', id: route.id, status: 'unavailable' })
      : undefined,
  }
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
