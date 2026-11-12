import { once } from 'node:events'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: process.env.DD_TEST_NODE_VERSION,
  })
  const [[initialized]] = await Promise.all([
    once(worker, 'message'),
    once(worker, 'exit'),
  ])

  // eslint-disable-next-line no-console
  console.log(initialized)
} else if (workerData) {
  Object.defineProperty(process.versions, 'node', { value: workerData })
  const { globalPreload } = await import('dd-trace/initialize.mjs')
  parentPort.postMessage(globalPreload())
} else {
  parentPort.postMessage(!!globalThis._ddtrace)
}
