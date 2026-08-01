import { once } from 'node:events'
import { isMainThread, parentPort, Worker } from 'node:worker_threads'

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url))
  const [initialized] = await once(worker, 'message')

  // eslint-disable-next-line no-console
  console.log(initialized)
} else {
  parentPort.postMessage(!!globalThis._ddtrace)
}
